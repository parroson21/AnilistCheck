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
        MediaListCollection(userName: $userName, type: ANIME, status: COMPLETED) {
          lists {
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
                const lists = res.data.MediaListCollection.lists;
                const entries = (lists && lists.length > 0) ? lists[0].entries : [];
                const stats = user.statistics.anime;

                const list: UserMedia[] = entries.map((e: any) => ({
                    id: e.media.id,
                    title: e.media.title.english || e.media.title.romaji,
                    coverImage: e.media.coverImage.large,
                    userScore: e.score,
                    duration: e.media.duration || 0,
                    episodes: e.media.episodes || 0
                }));

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
