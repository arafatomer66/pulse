import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Shared cursor-pagination query params. */
export class PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Capped so one call cannot pull an unbounded slice of the delivery log.
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  /** Absent when there are no more pages. */
  nextCursor?: string;
}

export function paginated<T>(items: T[], cursor: string | undefined): PaginatedResponse<T> {
  return { data: items, ...(cursor ? { nextCursor: cursor } : {}) };
}
