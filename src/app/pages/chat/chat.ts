import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { MediaChat } from '../../services/media-chat';
import { Router } from '@angular/router';

@Component({
  selector: 'app-chat',
  imports: [],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
})
export class Chat implements OnInit, OnDestroy {
  private readonly mediaChat = inject(MediaChat);
  private readonly router = inject(Router);
  protected readonly isScreenSharing = this.mediaChat.isScreenSharing;
  protected readonly isMicrophoneMuted = this.mediaChat.isMicrophoneMuted;

  public async ngOnInit(): Promise<void> {
    if (!this.mediaChat.isInitialized) {
      await this.router.navigate(['/']);
      return;
    }

    await this.mediaChat.start();
  }

  public ngOnDestroy(): void {
    this.mediaChat.stop().catch((err) => {
      console.error('[Chat] failed to stop media chat', err);
    });
  }

  public async startScreenShare(): Promise<void> {
    await this.mediaChat.startScreenShare();
  }

  public async stopScreenShare(): Promise<void> {
    await this.mediaChat.stopScreenShare();
  }

  public toggleMicrophone(): void {
    this.mediaChat.toggleMicrophone();
  }
}
