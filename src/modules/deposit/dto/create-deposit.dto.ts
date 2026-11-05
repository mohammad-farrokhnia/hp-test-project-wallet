import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { USER_ID_MESSAGE, USER_ID_PATTERN } from '../../../common/validation';

/**
 * `POST /deposits` body. Deposits are IRT only, so `currency` may be omitted. The amount stays a
 * string until `parseApiAmount`.
 */
export class CreateDepositDto {
  @IsString()
  @Matches(USER_ID_PATTERN, { message: USER_ID_MESSAGE })
  userId!: string;

  @IsString()
  amount!: string;

  @IsOptional()
  @IsIn(['IRT'])
  currency?: string;
}
