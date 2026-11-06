import { IsIn, IsString, Matches } from 'class-validator';
import { USER_ID_MESSAGE, USER_ID_PATTERN } from '../../../common/validation';

/** `POST /transfers` body. The amount stays a string until `parseApiAmount`. */
export class CreateTransferDto {
  @IsString()
  @Matches(USER_ID_PATTERN, { message: USER_ID_MESSAGE })
  fromUserId!: string;

  @IsString()
  @Matches(USER_ID_PATTERN, { message: USER_ID_MESSAGE })
  toUserId!: string;

  @IsIn(['IRT', 'USDT'])
  currency!: string;

  @IsString()
  amount!: string;
}
