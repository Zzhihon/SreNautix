// Telegram Bot API 的子集（https://core.telegram.org/bots/api），只包含本渠道用到的类型与字段。

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
}

/** 同时承载 MaybeInaccessibleMessage：date 为 0 表示消息对机器人已不可访问。 */
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  date: number;
  chat: TgChat;
  reply_to_message?: TgMessage;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  chat_instance: string;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** offset 与 length 以 UTF-16 code unit 计。 */
export interface TgEntity {
  type: 'bold' | 'code' | 'blockquote' | 'mention' | 'text_mention' | 'italic' | 'text_link';
  offset: number;
  length: number;
  url?: string;
  user?: TgUser;
}

export interface TgButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface TgInlineKeyboard {
  inline_keyboard: TgButton[][];
}

export interface TgForceReply {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
}

export interface SendMessageParams {
  chat_id: number;
  text: string;
  /** 与 entities 二选一 */
  parse_mode?: 'HTML';
  entities?: TgEntity[];
  link_preview_options?: { is_disabled: boolean };
  disable_notification?: boolean;
  reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
  reply_markup?: TgInlineKeyboard | TgForceReply;
}

export interface EditMessageTextParams {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: 'HTML';
  entities?: TgEntity[];
  link_preview_options?: { is_disabled: boolean };
  reply_markup?: TgInlineKeyboard;
}

export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface SetWebhookParams {
  url: string;
  secret_token: string;
  allowed_updates: string[];
  drop_pending_updates?: boolean;
}
