import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CHANNELS, LOCALES, type Channel, type Locale } from '@pulse/core';

export class RecipientDto {
  @IsOptional()
  @IsString()
  subscriberId?: string;

  /** The tenant's own user id, so callers need not store Pulse ids. */
  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class SendNotificationDto {
  @ValidateNested()
  @Type(() => RecipientDto)
  to!: RecipientDto;

  @IsOptional()
  @IsString()
  templateKey?: string;

  /**
   * Inline bodies for a one-off send. Validated structurally by the renderer
   * rather than field-by-field here — the shape is per-channel and optional
   * throughout, and a bad body surfaces as TEMPLATE_RENDER_FAILED.
   */
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsIn(CHANNELS, { each: true })
  channels?: Channel[];

  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  /** ISO-8601. Must not be in the past. */
  @IsOptional()
  @IsISO8601()
  sendAt?: string;
}

export class BroadcastDto {
  @IsString()
  templateKey!: string;

  @IsOptional()
  @IsArray()
  @IsIn(CHANNELS, { each: true })
  channels?: Channel[];

  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
