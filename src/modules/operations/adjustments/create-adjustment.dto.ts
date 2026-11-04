import { IsIn, IsString, Length, Matches } from 'class-validator';

/** `POST /internal/adjustments` body. The amount stays a string until `parseApiAmount`. */
export class CreateAdjustmentDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
    message: 'userId must be 1-64 characters from A-Z, a-z, 0-9, _ and -',
  })
  userId!: string;

  @IsIn(['IRT', 'USDT'])
  currency!: string;

  @IsString()
  amount!: string;

  @IsString()
  @Length(3, 500)
  reason!: string;
}
