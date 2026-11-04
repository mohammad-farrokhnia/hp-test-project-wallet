import { IsIn, IsString, Length, Matches } from 'class-validator';
import { USER_ID_MESSAGE, USER_ID_PATTERN } from '../../../common/validation';

/** `POST /internal/adjustments` body. The amount stays a string until `parseApiAmount`. */
export class CreateAdjustmentDto {
  @IsString()
  @Matches(USER_ID_PATTERN, { message: USER_ID_MESSAGE })
  userId!: string;

  @IsIn(['IRT', 'USDT'])
  currency!: string;

  @IsString()
  amount!: string;

  @IsString()
  @Length(3, 500)
  reason!: string;
}
