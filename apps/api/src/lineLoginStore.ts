export interface LineLoginContext {
  workspaceId: string;
  oaId: string;
  referralId: string;
  referralToken: string;
}

export interface StoredLineLoginFlow {
  stateHash: string;
  browserBindingHash: string;
  workspaceId: string;
  oaId: string;
  referralId: string;
  nonceHash: string;
  nonceSealed: string;
  codeVerifierSealed: string;
  referralTokenSealed: string;
  expiresAt: Date;
}

export interface CompleteLineLoginInput {
  stateHash: string;
  browserBindingHash: string;
  subjectHmac: string;
  displayName: string;
  sessionToken: string;
  expiresAt: Date;
}

export interface LineLoginSession {
  token: string;
  expiresAt: Date;
  customer: { id: string; displayName: string; role: 'customer' };
}

export interface LineLoginStore {
  resolveLineLoginMember(referralToken: string): LineLoginContext | Promise<LineLoginContext>;
  saveLineLoginFlow(flow: StoredLineLoginFlow): Promise<void> | void;
  getLineLoginFlow(stateHash: string, browserBindingHash: string): Promise<StoredLineLoginFlow | null> | StoredLineLoginFlow | null;
  completeLineLogin(input: CompleteLineLoginInput): Promise<LineLoginSession | null> | LineLoginSession | null;
  discardLineLoginState(stateHash: string, browserBindingHash: string): Promise<void> | void;
  getLineMemberSession(token: string): Promise<LineLoginSession['customer'] | null> | LineLoginSession['customer'] | null;
  revokeLineMemberSession(token: string): Promise<void> | void;
  cleanupExpiredLineLoginData(): Promise<void> | void;
}

export class InvalidLineLoginReferralError extends Error {}
