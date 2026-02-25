import { Component, inject, signal, computed, OnInit, effect } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AnilistService, UserData, UserMedia } from './services/anilist.service';

interface UserSlot {
  name: string;
  data: UserData | null;
  loading: boolean;
  showSuggestions: boolean;
}

interface SharedEntry {
  anime: UserMedia;
  scores: { name: string; score: number; avatar: string }[];
  overlapCount: number;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private readonly anilist = inject(AnilistService);

  protected readonly users = signal<UserSlot[]>([
    { name: '', data: null, loading: false, showSuggestions: false },
    { name: '', data: null, loading: false, showSuggestions: false }
  ]);

  protected readonly pastUsernames = signal<string[]>([]);
  protected readonly statsExpanded = signal(false);
  protected readonly selectedOverlap = signal<number | null>(null);
  protected readonly excludedIndices = signal<Set<number>>(new Set());

  // All users with data (for chip rendering)
  protected readonly allLoadedUsers = computed(() =>
    this.users()
      .map((u, i) => ({ ...u, index: i }))
      .filter(u => u.data !== null)
  );

  // Only active (non-excluded) users for comparison
  protected readonly loadedUsers = computed(() => {
    const excluded = this.excludedIndices();
    return this.users().filter((u, i) => u.data !== null && !excluded.has(i));
  });

  // All anime with their overlap counts
  protected readonly allSharedEntries = computed<SharedEntry[]>(() => {
    const loaded = this.loadedUsers();
    if (loaded.length < 2) return [];

    // Collect every unique anime across all users
    const animeMap = new Map<number, { anime: UserMedia; users: { name: string; score: number; avatar: string }[] }>();

    for (const user of loaded) {
      for (const anime of user.data!.list) {
        if (!animeMap.has(anime.id)) {
          animeMap.set(anime.id, { anime, users: [] });
        }
        animeMap.get(anime.id)!.users.push({
          name: user.data!.name,
          score: anime.userScore,
          avatar: user.data!.avatar
        });
      }
    }

    // Only include anime seen by 2+ users
    return Array.from(animeMap.values())
      .filter(entry => entry.users.length >= 2)
      .map(entry => ({
        anime: entry.anime,
        scores: entry.users,
        overlapCount: entry.users.length
      }))
      .sort((a, b) => b.overlapCount - a.overlapCount);
  });

  // Available overlap levels (e.g. for 3 users: [3, 2])
  protected readonly overlapLevels = computed(() => {
    const loaded = this.loadedUsers();
    if (loaded.length < 2) return [];
    const levels: number[] = [];
    for (let i = loaded.length; i >= 2; i--) {
      levels.push(i);
    }
    return levels;
  });

  // Filtered entries based on selected overlap
  protected readonly filteredShared = computed(() => {
    const all = this.allSharedEntries();
    const selected = this.selectedOverlap();
    const loaded = this.loadedUsers();

    if (selected === null) {
      // Default: show entries where ALL loaded users have it
      return all.filter(e => e.overlapCount === loaded.length);
    }
    return all.filter(e => e.overlapCount === selected);
  });

  protected readonly stats = computed(() => {
    const loaded = this.loadedUsers();
    if (loaded.length < 2) return null;

    const allEntries = this.allSharedEntries();
    const fullyShared = allEntries.filter(e => e.overlapCount === loaded.length);

    // Watch time for each user
    const watchTimes = loaded.map(u => ({
      name: u.data!.name,
      minutes: u.data!.watchedTime,
      days: Math.round(u.data!.watchedTime / 1440)
    }));

    // Average score difference for fully shared shows
    const scoreDiffs: number[] = [];
    for (const entry of fullyShared) {
      const ratedScores = entry.scores.filter(s => s.score > 0).map(s => s.score);
      if (ratedScores.length >= 2) {
        scoreDiffs.push(Math.max(...ratedScores) - Math.min(...ratedScores));
      }
    }
    const avgScoreDiff = scoreDiffs.length > 0
      ? (scoreDiffs.reduce((a, b) => a + b, 0) / scoreDiffs.length).toFixed(1)
      : 'N/A';

    // Total unique anime across all users
    const allAnimeIds = new Set<number>();
    loaded.forEach(u => u.data!.list.forEach(a => allAnimeIds.add(a.id)));

    return {
      sharedCount: fullyShared.length,
      totalUniqueCount: allAnimeIds.size,
      watchTimes,
      avgScoreDiff
    };
  });

  constructor() {
    effect(() => {
      const names = this.users()
        .filter(u => u.data !== null)
        .map(u => u.name);
      if (names.length > 0) {
        localStorage.setItem('anicompare_users', JSON.stringify(names));
      }
    });
  }

  ngOnInit() {
    const pastRaw = localStorage.getItem('anicompare_past_usernames');
    if (pastRaw) {
      this.pastUsernames.set(JSON.parse(pastRaw));
    }

    const savedRaw = localStorage.getItem('anicompare_users');
    if (savedRaw) {
      const savedNames: string[] = JSON.parse(savedRaw);
      if (savedNames.length >= 1) {
        const slots: UserSlot[] = savedNames.map(name => ({
          name,
          data: null,
          loading: false,
          showSuggestions: false
        }));
        // Ensure at least 2 slots
        while (slots.length < 2) {
          slots.push({ name: '', data: null, loading: false, showSuggestions: false });
        }
        this.users.set(slots);
        slots.forEach((s, i) => {
          if (s.name) this.fetchUser(i);
        });
      }
    }
  }

  fetchUser(index: number) {
    const users = [...this.users()];
    const slot = users[index];
    if (!slot.name) return;

    slot.loading = true;
    slot.showSuggestions = false;
    this.users.set([...users]);

    this.addToPastUsernames(slot.name);

    this.anilist.getUserData(slot.name).subscribe({
      next: (data) => {
        const current = [...this.users()];
        current[index] = { ...current[index], data, loading: false };
        this.users.set(current);
      },
      error: () => {
        const current = [...this.users()];
        current[index] = { ...current[index], data: null, loading: false };
        this.users.set(current);
      }
    });
  }

  clearUser(index: number) {
    const current = [...this.users()];
    if (current.length <= 1) return;

    // If we have more than 2 slots, remove entirely
    if (current.length > 2) {
      current.splice(index, 1);
    } else {
      // Reset the slot instead of removing
      current[index] = { name: '', data: null, loading: false, showSuggestions: false };
    }
    this.users.set(current);
    // Reset overlap filter
    this.selectedOverlap.set(null);
  }

  addUser() {
    this.users.set([
      ...this.users(),
      { name: '', data: null, loading: false, showSuggestions: false }
    ]);
  }

  resetAll() {
    localStorage.removeItem('anicompare_users');
    this.users.set([
      { name: '', data: null, loading: false, showSuggestions: false },
      { name: '', data: null, loading: false, showSuggestions: false }
    ]);
    this.statsExpanded.set(false);
    this.selectedOverlap.set(null);
    this.excludedIndices.set(new Set());
  }

  toggleStatsExpand() {
    this.statsExpanded.set(!this.statsExpanded());
  }

  setOverlapFilter(level: number | null) {
    this.selectedOverlap.set(level);
  }

  toggleUserExclusion(index: number) {
    const current = new Set(this.excludedIndices());
    if (current.has(index)) {
      current.delete(index);
    } else {
      current.add(index);
    }
    this.excludedIndices.set(current);
    // Reset overlap filter since user count changed
    this.selectedOverlap.set(null);
  }

  isExcluded(index: number): boolean {
    return this.excludedIndices().has(index);
  }

  onInputFocus(index: number) {
    const current = [...this.users()];
    current[index] = { ...current[index], showSuggestions: true };
    this.users.set(current);
  }

  onInputBlur(index: number) {
    setTimeout(() => {
      const current = [...this.users()];
      current[index] = { ...current[index], showSuggestions: false };
      this.users.set(current);
    }, 200);
  }

  selectSuggestion(index: number, name: string) {
    const current = [...this.users()];
    current[index] = { ...current[index], name, showSuggestions: false };
    this.users.set(current);
    this.fetchUser(index);
  }

  filteredSuggestions(index: number): string[] {
    const query = this.users()[index].name.toLowerCase();
    const currentNames = this.users().map(u => u.name.toLowerCase());
    return this.pastUsernames()
      .filter(name =>
        name.toLowerCase().includes(query) &&
        !currentNames.includes(name.toLowerCase())
      )
      .slice(0, 5);
  }

  formatTime(minutes: number): string {
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    return `${days}d ${hours}h`;
  }

  overlapLabel(level: number): string {
    const total = this.loadedUsers().length;
    if (level === total) return `All ${total}`;
    return `${level} of ${total}`;
  }

  private addToPastUsernames(name: string) {
    const current = this.pastUsernames();
    const lower = name.toLowerCase();
    if (!current.some(n => n.toLowerCase() === lower)) {
      const updated = [name, ...current].slice(0, 20);
      this.pastUsernames.set(updated);
      localStorage.setItem('anicompare_past_usernames', JSON.stringify(updated));
    }
  }
}
