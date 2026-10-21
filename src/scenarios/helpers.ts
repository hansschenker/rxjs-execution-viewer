import { Observable } from 'rxjs';
import type { VirtualTimeScheduler } from 'rxjs';

export type ScheduledNotification<T> =
  | { time: number; kind: 'next'; value: T }
  | { time: number; kind: 'complete' }
  | { time: number; kind: 'error'; error: unknown };

/** Each subscription schedules its own notifications and owns their teardown. */
export function coldNotifications<T>(scheduler: VirtualTimeScheduler, notifications: ScheduledNotification<T>[]): Observable<T> {
  return new Observable<T>(function startColdSource(subscriber) {
    for (const notification of notifications) {
      const action = scheduler.schedule(function deliverNotification() {
        if (notification.kind === 'next') subscriber.next(notification.value);
        else if (notification.kind === 'complete') subscriber.complete();
        else subscriber.error(notification.error);
      }, notification.time);
      subscriber.add(action);
    }
  });
}
