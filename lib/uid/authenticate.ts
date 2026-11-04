import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { authDb } from "@/lib/db/auth-connection";
import { authSessions } from "@/lib/db/schema";
import { accountAddresses, userByAuthUserId } from "@/lib/db/accounts";
import { authSessionLive } from "@/lib/db/identity";
import { isUidSiteCaller, mayOpenUid } from "@/lib/auth/uid-sites";
import { MemberError } from "./member-policy";
import type { UidActor } from "@/lib/db/uid-members";

/** Bind the caller's host, live MFA sign-in and verified account. An email alone grants nothing. */
export async function authenticateUid(authorization:string|null,input:{host?:unknown;session?:unknown;email?:unknown}):Promise<UidActor>{
  const host=typeof input.host==='string'?input.host.toLowerCase():'';
  const session=typeof input.session==='string'?input.session:'';
  const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
  if(!isUidSiteCaller(host,authorization)||session.length<16||session.length>256||!mayOpenUid(host,email))
    throw new MemberError('Sign in again.',401);
  const [signIn]=await authDb().select({userId:authSessions.userId}).from(authSessions)
    .where(and(eq(authSessions.id,session),isNotNull(authSessions.mfaVerifiedAt))).limit(1);
  if(!signIn||!await authSessionLive(session))throw new MemberError('Sign in again.',401);
  const account=await userByAuthUserId(signIn.userId);
  if(!account)throw new MemberError('Sign in again.',401);
  const addresses=await accountAddresses(account.id);
  if(!addresses.includes(email))throw new MemberError('Sign in again.',401);
  return {userId:account.id,email,name:account.fullName||'',addresses};
}
