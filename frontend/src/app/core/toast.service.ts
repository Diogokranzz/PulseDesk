import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly message = signal('');
  readonly isError = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  show(message: string, isError = false): void {
    this.message.set(message);
    this.isError.set(isError);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(''), 4500);
  }
}
