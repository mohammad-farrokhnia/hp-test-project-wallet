import { IsIn, IsString, Length, Matches } from 'class-validator';
import { USER_ID_MESSAGE, USER_ID_PATTERN } from '../../../common/validation';

/** `POST /withdrawals` body. The amount stays a string until `parseApiAmount`;
 * the destination type follows from the currency.
 */
export class CreateWithdrawalDto {
  @IsString()
  @Matches(USER_ID_PATTERN, { message: USER_ID_MESSAGE })
  userId!: string;

  @IsIn(['IRT', 'USDT'])
  currency!: string;

  @IsString()
  amount!: string;

  /** IRT: a Sheba IBAN (spaces and lowercase allowed). USDT: a TRC20 address. */
  @IsString()
  @Length(1, 64)
  destination!: string;
}
