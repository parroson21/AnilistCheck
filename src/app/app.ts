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
  avgScore: number; // average of rated scores (>0), 0 if none rated
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
  protected readonly selectedOverlap = signal<number | null>(null);
  protected readonly excludedIndices = signal<Set<number>>(new Set());
  protected readonly sortOrder = signal<'score-desc' | 'score-asc'>('score-desc');

  // Adding new user — controls the inline "add" input at the end of chips
  protected readonly addingUser = signal(false);
  protected readonly addingName = signal('');
  protected readonly addingSuggestions = signal(false);

  // All users with data (for chip rendering)
  protected readonly allLoadedUsers = computed(() =>
    this.users()
      .map((u, i) => ({ ...u, index: i }))
      .filter(u => u.data !== null)
  );

  // Active (non-excluded) users for comparison
  protected readonly loadedUsers = computed(() => {
    const excluded = this.excludedIndices();
    return this.users().filter((u, i) => u.data !== null && !excluded.has(i));
  });

  // All anime with overlap counts across active users
  protected readonly allSharedEntries = computed<SharedEntry[]>(() => {
    const loaded = this.loadedUsers();
    if (loaded.length < 2) return [];

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

    return Array.from(animeMap.values())
      .filter(entry => entry.users.length >= 2)
      .map(entry => {
        const rated = entry.users.filter(u => u.score > 0).map(u => u.score);
        const avgScore = rated.length > 0
          ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10
          : 0;
        return {
          anime: entry.anime,
          scores: entry.users,
          overlapCount: entry.users.length,
          avgScore
        };
      })
      .sort((a, b) => b.overlapCount - a.overlapCount);
  });

  // Available overlap filter levels
  protected readonly overlapLevels = computed(() => {
    const loaded = this.loadedUsers();
    if (loaded.length < 2) return [];
    const levels: number[] = [];
    for (let i = loaded.length; i >= 2; i--) levels.push(i);
    return levels;
  });

  // Filtered + sorted entries by selected overlap
  protected readonly filteredShared = computed(() => {
    const all = this.allSharedEntries();
    const selected = this.selectedOverlap();
    const total = this.loadedUsers().length;
    const sort = this.sortOrder();

    const filtered = all.filter(e => e.overlapCount === (selected ?? total));

    if (sort === 'score-asc') return [...filtered].sort((a, b) => a.avgScore - b.avgScore);
    return [...filtered].sort((a, b) => b.avgScore - a.avgScore); // default: score-desc
  });

  protected readonly stats = computed(() => {
    const loaded = this.loadedUsers();
    if (loaded.length < 2) return null;

    const fullyShared = this.allSharedEntries().filter(e => e.overlapCount === loaded.length);

    // Build a set of all anime IDs seen by each other user (union minus self)
    const watchTimes = loaded.map(u => {
      const otherIds = new Set<number>();
      loaded.forEach(other => {
        if (other !== u) other.data!.list.forEach(a => otherIds.add(a.id));
      });
      const uniqueCount = u.data!.list.filter(a => !otherIds.has(a.id)).length;
      return {
        name: u.data!.name,
        minutes: u.data!.watchedTime,
        avatar: u.data!.avatar,
        uniqueCount
      };
    });

    const scoreDiffs: number[] = [];
    for (const entry of fullyShared) {
      const rated = entry.scores.filter(s => s.score > 0).map(s => s.score);
      if (rated.length >= 2) scoreDiffs.push(Math.max(...rated) - Math.min(...rated));
    }
    const avgScoreDiff = scoreDiffs.length > 0
      ? (scoreDiffs.reduce((a, b) => a + b, 0) / scoreDiffs.length).toFixed(1)
      : 'N/A';

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
    if (pastRaw) this.pastUsernames.set(JSON.parse(pastRaw));

    const savedRaw = localStorage.getItem('anicompare_users');
    if (savedRaw) {
      const savedNames: string[] = JSON.parse(savedRaw);
      if (savedNames.length >= 1) {
        const slots: UserSlot[] = savedNames.map(name => ({
          name, data: null, loading: false, showSuggestions: false
        }));
        while (slots.length < 2) {
          slots.push({ name: '', data: null, loading: false, showSuggestions: false });
        }
        this.users.set(slots);
        slots.forEach((s, i) => { if (s.name) this.fetchUser(i); });
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

  removeUser(index: number) {
    const current = [...this.users()];
    current.splice(index, 1);
    // Ensure at least 2 empty slots remain
    while (current.length < 2) {
      current.push({ name: '', data: null, loading: false, showSuggestions: false });
    }
    this.users.set(current);

    // Clean up exclusions
    const excluded = new Set(this.excludedIndices());
    excluded.delete(index);
    this.excludedIndices.set(excluded);
    this.selectedOverlap.set(null);
  }

  // --- Adding new user via the inline chip ---
  startAdding() {
    this.addingUser.set(true);
    this.addingName.set('');
  }

  cancelAdding() {
    this.addingUser.set(false);
    this.addingName.set('');
    this.addingSuggestions.set(false);
  }

  // Called on blur — short delay so mousedown on suggestions fires first
  onAddBlur() {
    this.addingSuggestions.set(false);
    setTimeout(() => {
      if (this.addingUser()) {
        this.confirmAdding();
      }
    }, 200);
  }

  confirmAdding() {
    const name = this.addingName().trim();
    if (!name) { this.cancelAdding(); return; }
    const current = [...this.users()];
    // Find first empty slot or append new
    const emptyIdx = current.findIndex(u => !u.name && !u.data);
    if (emptyIdx >= 0) {
      current[emptyIdx] = { name, data: null, loading: false, showSuggestions: false };
      this.users.set(current);
      this.fetchUser(emptyIdx);
    } else {
      this.users.set([...current, { name, data: null, loading: false, showSuggestions: false }]);
      this.fetchUser(current.length);
    }
    this.cancelAdding();
  }

  filteredAddSuggestions(): string[] {
    const query = this.addingName().toLowerCase();
    const currentNames = this.users().map(u => u.name.toLowerCase());
    return this.pastUsernames()
      .filter(n => n.toLowerCase().includes(query) && !currentNames.includes(n.toLowerCase()))
      .slice(0, 5);
  }

  selectAddSuggestion(name: string) {
    this.addingName.set(name);
    this.addingSuggestions.set(false);
    this.confirmAdding();
  }

  resetAll() {
    localStorage.removeItem('anicompare_users');
    this.users.set([
      { name: '', data: null, loading: false, showSuggestions: false },
      { name: '', data: null, loading: false, showSuggestions: false }
    ]);
    this.excludedIndices.set(new Set());
    this.selectedOverlap.set(null);
    this.sortOrder.set('score-desc');
    this.cancelAdding();
  }

  toggleUserExclusion(index: number) {
    const current = new Set(this.excludedIndices());
    if (current.has(index)) current.delete(index);
    else current.add(index);
    this.excludedIndices.set(current);
    this.selectedOverlap.set(null);
  }

  isExcluded(index: number): boolean {
    return this.excludedIndices().has(index);
  }

  setOverlapFilter(level: number | null) {
    this.selectedOverlap.set(level);
  }

  toggleSort() {
    this.sortOrder.set(this.sortOrder() === 'score-desc' ? 'score-asc' : 'score-desc');
  }

  sortLabel(): string {
    return this.sortOrder() === 'score-desc' ? 'Avg Score ↓' : 'Avg Score ↑';
  }

  overlapLabel(level: number): string {
    const total = this.loadedUsers().length;
    return level === total ? `All ${total}` : `${level} of ${total}`;
  }

  formatTime(minutes: number): string {
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    return `${days}d ${hours}h`;
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
