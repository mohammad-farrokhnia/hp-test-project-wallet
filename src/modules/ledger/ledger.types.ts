/**
 * @description The three accounts a user holds in one currency. Ids are `bigint` so lock ordering compares numerically.
 */
export interface UserAccountIds {
  readonly available: bigint;
  readonly frozen: bigint;
  readonly debt: bigint;
}
