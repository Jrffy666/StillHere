import { mkdir, readFile, writeFile, chmod, lstat } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
import { COMMUNITY_CONFIG_SIZE, COMMUNITY_JOURNEY_SIZE, COMMUNITY_RECORD_SIZE } from '../src/community.ts';

const root=new URL('../../contracts/',import.meta.url);
await mkdir(new URL('target/deploy/',root),{recursive:true});
await mkdir(new URL('.keys/',root),{recursive:true,mode:0o700});
async function readKey(url:URL):Promise<Keypair|null>{try{if((await lstat(url)).isSymbolicLink())throw new Error('Community key files cannot be symlinks.');return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(url,'utf8'))));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
let previous:{programId:string;issuer:string;sponsor:string}|null=null;
try{previous=JSON.parse(await readFile(new URL('deployment-community.json',root),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
async function keyPair(name:string,recordedId?:string,deployName?:string):Promise<Keypair>{
  const url=new URL(`.keys/community-${name}.json`,root),deployUrl=deployName?new URL(`target/deploy/${deployName}-keypair.json`,root):null;
  const existing=await readKey(url),deployed=deployUrl?await readKey(deployUrl):null;
  if(existing&&deployed&&!existing.publicKey.equals(deployed.publicKey))throw new Error(`Mismatched ${name} key copies.`);
  if(recordedId&&!existing&&!deployed)throw new Error(`Recorded ${name} identity exists but its original key is absent. Refusing to replace it.`);
  const value=existing??deployed??Keypair.generate();
  if(recordedId&&value.publicKey.toBase58()!==recordedId)throw new Error(`The ${name} key does not match deployment metadata.`);
  if(!existing)await writeFile(url,JSON.stringify([...value.secretKey]),{flag:'wx',mode:0o600});await chmod(url,0o600);
  if(deployUrl){if(!deployed)await writeFile(deployUrl,JSON.stringify([...value.secretKey]),{flag:'wx',mode:0o600});await chmod(deployUrl,0o600);}
  return value;
}
const program=await keyPair('program',previous?.programId,'community_ledger');
const issuer=await keyPair('issuer',previous?.issuer),sponsor=await keyPair('sponsor',previous?.sponsor);
const source=new URL('programs/community-ledger/src/lib.rs',root);
await writeFile(source,(await readFile(source,'utf8')).replace(/declare_id!\("[^"]+"\)/,`declare_id!("${program.publicKey.toBase58()}")`));
await writeFile(new URL('deployment-community.json',root),JSON.stringify({version:1,programId:program.publicKey.toBase58(),issuer:issuer.publicKey.toBase58(),sponsor:sponsor.publicKey.toBase58(),provenance:'platform-attested',ruleVersion:1,pointsPool:25,reputationPool:10,maxGuardians:16,configAccountSize:COMMUNITY_CONFIG_SIZE,journeyAccountSize:COMMUNITY_JOURNEY_SIZE,recordAccountSize:COMMUNITY_RECORD_SIZE},null,2)+'\n');
console.log(JSON.stringify({prepared:true,programId:program.publicKey.toBase58(),issuer:issuer.publicKey.toBase58(),sponsor:sponsor.publicKey.toBase58(),transactionsSubmitted:0}));
