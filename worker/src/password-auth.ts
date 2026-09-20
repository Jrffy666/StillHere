import { z } from 'zod';

export const usernameSchema=z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/);
// Passwords are intentionally neither trimmed nor Unicode-normalized.
export const passwordSchema=z.string().min(12).max(128);
export const PASSWORD_ITERATIONS=100_000;
const hex=(bytes:Uint8Array)=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const bytes=(value:string)=>Uint8Array.from(value.match(/../g)!,part=>parseInt(part,16));
const verifierSchema=z.object({version:z.literal(1),algorithm:z.literal('PBKDF2-SHA-256'),iterations:z.literal(PASSWORD_ITERATIONS),salt:z.string().regex(/^[a-f0-9]{64}$/),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type PasswordVerifier=z.infer<typeof verifierSchema>;
// Workerd's production PBKDF2 limit is 100,000 iterations per derivation.
// Versioned parameters allow a future KDF migration without exporting credentials.
async function derive(password:string,salt:string):Promise<string>{
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:bytes(salt),iterations:PASSWORD_ITERATIONS},material,256)));
}
export async function hashPassword(password:string):Promise<string>{
  passwordSchema.parse(password);
  const salt=hex(crypto.getRandomValues(new Uint8Array(32)));
  return JSON.stringify({version:1,algorithm:'PBKDF2-SHA-256',iterations:PASSWORD_ITERATIONS,salt,hash:await derive(password,salt)} satisfies PasswordVerifier);
}
export function validPasswordVerifier(value:string):boolean {
  try{return verifierSchema.safeParse(JSON.parse(value)).success;}catch{return false;}
}
export async function verifyPassword(password:string,encoded:string|null):Promise<boolean>{
  passwordSchema.parse(password);
  let stored:PasswordVerifier|null=null;
  try{const parsed=verifierSchema.safeParse(encoded?JSON.parse(encoded):null);if(parsed.success)stored=parsed.data;}catch{/* Use the same derivation for missing credentials. */}
  const actual=await derive(password,stored?.salt??'0'.repeat(64));
  return Boolean(stored&&crypto.subtle.timingSafeEqual(bytes(actual),bytes(stored.hash)));
}
