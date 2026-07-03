import { Module } from '@nestjs/common';
import { EscalationNotifier } from './escalation-notifier';
import { TelegramClient } from './telegram.client';

/**
 * Staff notification channel (Telegram). Pure infra: no imports needed —
 * AppConfigModule is global, so ConfigService is injectable here directly.
 */
@Module({
  providers: [TelegramClient, EscalationNotifier],
  exports: [EscalationNotifier],
})
export class NotificationsModule {}
