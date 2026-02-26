import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface UserMedia {
  id: number;
  title: string;
  coverImage: string;
  userScore: number;
  duration: number;
  episodes: number;
  status: 'COMPLETED' | 'DROPPED';
}

export interface UserData {
  name: string;
  avatar: string;
  watchedTime: number;
  completedCount: number;
  list: UserMedia[];
}

@Injectable({
  providedIn: 'root'
})
export class AnilistService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = 'https://graphql.anilist.co';

  getUserData(userName: string): Observable<UserData> {
    const query = `
      query ($userName: String) {
        MediaListCollection(userName: $userName, type: ANIME) {
          lists {
            status
            entries {
              media {
                id
                title {
                  english
                  romaji
                }
                coverImage {
                  large
                }
                duration
                episodes
              }
              score(format: POINT_10)
            }
          }
        }
        User(name: $userName) {
          name
          avatar {
            large
          }
          statistics {
            anime {
              count
              minutesWatched
              statuses {
                status
                count
              }
            }
          }
        }
      }
    `;

    return this.http.post<any>(this.apiUrl, {
      query,
      variables: { userName }
    }).pipe(
      map(res => {
        const user = res.data.User;
        const lists: any[] = res.data.MediaListCollection.lists ?? [];
        const stats = user.statistics.anime;

        // Collect entries from COMPLETED and DROPPED lists only
        const list: UserMedia[] = [];
        for (const l of lists) {
          const s: string = l.status;
          if (s !== 'COMPLETED' && s !== 'DROPPED') continue;
          for (const e of l.entries) {
            list.push({
              id: e.media.id,
              title: e.media.title.english || e.media.title.romaji,
              coverImage: e.media.coverImage.large,
              userScore: e.score,
              duration: e.media.duration || 0,
              episodes: e.media.episodes || 0,
              status: s as 'COMPLETED' | 'DROPPED'
            });
          }
        }

        const completedStatus = stats.statuses.find((s: any) => s.status === 'COMPLETED');

        return {
          name: user.name,
          avatar: user.avatar.large,
          watchedTime: stats.minutesWatched,
          completedCount: completedStatus ? completedStatus.count : stats.count,
          list
        };
      })
    );
  }
}
