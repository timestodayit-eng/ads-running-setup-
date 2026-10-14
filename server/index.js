import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {S3Client,CreateMultipartUploadCommand,UploadPartCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {randomUUID} from 'node:crypto';

const app=express();app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'200kb'}));
const PORT=Number(process.env.PORT||3000);
const SUPABASE_URL=process.env.SUPABASE_URL, ANON=process.env.SUPABASE_ANON_KEY, SERVICE=process.env.SUPABASE_SERVICE_ROLE_KEY;
const ready=Boolean(SUPABASE_URL&&ANON&&SERVICE);
const authClient=ready?createClient(SUPABASE_URL,ANON,{auth:{persistSession:false}}):null;
const db=ready?createClient(SUPABASE_URL,SERVICE,{auth:{persistSession:false}}):null;
const bucket=process.env.R2_BUCKET;
const r2ok=Boolean(process.env.R2_ACCOUNT_ID&&process.env.R2_ACCESS_KEY_ID&&process.env.R2_SECRET_ACCESS_KEY&&bucket);
const s3=r2ok?new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}}):null;
const fail=(res,code,message)=>res.status(code).json({error:message});
const result=async(q)=>{const {data,error}=await q;if(error)throw Error(error.message);return data};
const handler=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
async function protectedRoute(req,res,next){
  if(!ready)return fail(res,503,'Backend not configured. Set Supabase environment variables.');
  const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
  if(!token)return fail(res,401,'Sign in required');
  const {data,error}=await authClient.auth.getUser(token);
  if(error||!data?.user)return fail(res,401,'Invalid or expired session');
  req.user=data.user;
  // No public signup. Only admin-issued users in the allowlist may access company records.
  const {data:staff,error:staffError}=await db.from('staff').select('id,role,active').eq('id',req.user.id).maybeSingle();
  if(staffError)return fail(res,500,staffError.message);
  if(!staff?.active)return fail(res,403,'Your account has not been approved by an administrator');
  req.role=staff.role;next();
}
const manager=(req,res,next)=>['super_admin','ads_manager'].includes(req.role)?next():fail(res,403,'Manager permission required');
const admin=(req,res,next)=>req.role==='super_admin'?next():fail(res,403,'Administrator permission required');
app.get('/api/health',(_req,res)=>res.json({ok:true,configured:ready,storageConfigured:r2ok,metaConfigured:Boolean(process.env.META_ACCESS_TOKEN)}));
app.use('/api',protectedRoute);
app.get('/api/me',(req,res)=>res.json({email:req.user.email,role:req.role,id:req.user.id}));
app.get('/api/accounts',handler(async(req,res)=>res.json({accounts:await result(db.from('ad_accounts').select('*').order('slot'))})));
app.patch('/api/accounts/:id',manager,handler(async(req,res)=>{
 const allowed=['label','daily_budget','audience_note','phone','start_date','end_date','selected'];const update={};
 for(const key of allowed)if(Object.hasOwn(req.body,key))update[key]=req.body[key];
 if(Object.hasOwn(update,'daily_budget')&&(!Number.isFinite(Number(update.daily_budget))||Number(update.daily_budget)<0))return fail(res,400,'Invalid budget');
 if(update.phone&&!/^\+?[0-9]{8,16}$/.test(String(update.phone).replace(/\s/g,'')))return fail(res,400,'Invalid phone number');
 if(!Object.keys(update).length)return fail(res,400,'No valid fields');
 const rows=await result(db.from('ad_accounts').update(update).eq('id',req.params.id).select());
 if(!rows.length)return fail(res,404,'Account not found');res.json({account:rows[0]});
}));
app.get('/api/videos',handler(async(req,res)=>res.json({videos:await result(db.from('videos').select('id,name,size_bytes,mime_type,status,created_at').order('created_at',{ascending:false}))})));
app.post('/api/videos/start',manager,handler(async(req,res)=>{
 if(!s3)return fail(res,503,'R2 video storage not configured');
 const {name,size,mime}=req.body;
 if(typeof name!=='string'||name.length>200||!Number.isInteger(size)||size<1||size>1073741824)return fail(res,400,'Maximum video size is 1 GiB');
 if(!['video/mp4','video/quicktime','video/webm'].includes(mime))return fail(res,400,'MP4, MOV or WebM only');
 const id=randomUUID(),key=`videos/${id}/${name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
 const uploaded=await s3.send(new CreateMultipartUploadCommand({Bucket:bucket,Key:key,ContentType:mime}));
 await result(db.from('videos').insert({id,name,size_bytes:size,mime_type:mime,object_key:key,upload_id:uploaded.UploadId,status:'uploading',uploaded_by:req.user.id}));
 res.json({id,uploadId:uploaded.UploadId,chunkSize:16*1024*1024});
}));
async function getUpload(id){return (await result(db.from('videos').select('*').eq('id',id).maybeSingle()));}
app.post('/api/videos/:id/part-url',manager,handler(async(req,res)=>{
 const v=await getUpload(req.params.id);if(!v||v.status!=='uploading')return fail(res,404,'Upload not found');
 const partNumber=Number(req.body.partNumber);if(!Number.isInteger(partNumber)||partNumber<1||partNumber>10000)return fail(res,400,'Invalid part');
 const url=await getSignedUrl(s3,new UploadPartCommand({Bucket:bucket,Key:v.object_key,UploadId:v.upload_id,PartNumber:partNumber}),{expiresIn:900});res.json({url});
}));
app.post('/api/videos/:id/complete',manager,handler(async(req,res)=>{
 const v=await getUpload(req.params.id);if(!v||v.status!=='uploading')return fail(res,404,'Upload not found');
 const parts=req.body.parts;if(!Array.isArray(parts)||!parts.length||parts.length>10000||parts.some(p=>!Number.isInteger(p.PartNumber)||typeof p.ETag!=='string'))return fail(res,400,'Invalid parts');
 await s3.send(new CompleteMultipartUploadCommand({Bucket:bucket,Key:v.object_key,UploadId:v.upload_id,MultipartUpload:{Parts:parts.sort((a,b)=>a.PartNumber-b.PartNumber)}}));
 await result(db.from('videos').update({status:'ready',upload_id:null}).eq('id',v.id));res.json({ok:true});
}));
app.post('/api/videos/:id/abort',manager,handler(async(req,res)=>{
 const v=await getUpload(req.params.id);if(!v||v.status!=='uploading')return fail(res,404,'Upload not found');
 await s3.send(new AbortMultipartUploadCommand({Bucket:bucket,Key:v.object_key,UploadId:v.upload_id}));
 await result(db.from('videos').update({status:'aborted',upload_id:null}).eq('id',v.id));res.json({ok:true});
}));
app.get('/api/drafts',handler(async(req,res)=>res.json({drafts:await result(db.from('campaign_drafts').select('*').order('created_at',{ascending:false}).limit(100))})));
app.post('/api/drafts',manager,handler(async(req,res)=>{
 const {name,objective,video_id,caption,headline,items}=req.body;
 if(typeof name!=='string'||name.trim().length<3||name.length>160)return fail(res,400,'Campaign name required');
 if(!['OUTCOME_LEADS','OUTCOME_TRAFFIC','OUTCOME_ENGAGEMENT','OUTCOME_AWARENESS'].includes(objective))return fail(res,400,'Invalid objective');
 if(typeof caption!=='string'||!caption.trim()||caption.length>5000||typeof headline!=='string'||headline.length>255)return fail(res,400,'Invalid creative');
 if(!Array.isArray(items)||items.length<1||items.length>10)return fail(res,400,'Select 1–10 accounts');
 const ids=[...new Set(items.map(x=>x.account_id))];if(ids.length!==items.length)return fail(res,400,'Duplicate accounts');
 const known=await result(db.from('ad_accounts').select('id,meta_account_id').in('id',ids));if(known.length!==ids.length)return fail(res,400,'Unknown account');
 const video=await result(db.from('videos').select('id,status').eq('id',video_id).maybeSingle());if(!video||video.status!=='ready')return fail(res,400,'Choose a completely uploaded video');
 for(const x of items){if(!Number.isFinite(Number(x.daily_budget))||Number(x.daily_budget)<1||typeof x.audience_note!=='string'||!/^\+?[0-9]{8,16}$/.test(String(x.phone||'').replace(/\s/g,''))||!/^\d{4}-\d{2}-\d{2}$/.test(x.start_date||'')||!/^\d{4}-\d{2}-\d{2}$/.test(x.end_date||'')||x.end_date<x.start_date)return fail(res,400,'Invalid account configuration');}
 const draft=await result(db.from('campaign_drafts').insert({name:name.trim(),objective,special_ad_categories:['EMPLOYMENT'],video_id,caption,headline,items,status:'draft',created_by:req.user.id}).select().single());
 res.status(201).json({draft});
}));
app.get('/api/meta/status',handler(async(req,res)=>res.json({configured:Boolean(process.env.META_ACCESS_TOKEN),message:'Account sync requires an authorized Meta token. Campaign publishing is not enabled in this release.'})));
app.post('/api/meta/sync-accounts',admin,handler(async(req,res)=>{
 const token=process.env.META_ACCESS_TOKEN,version=process.env.META_API_VERSION||'v25.0';
 if(!token)return fail(res,503,'META_ACCESS_TOKEN not set');
 if(!/^v\d+\.\d+$/.test(version))return fail(res,500,'Invalid API version');
 let url=`https://graph.facebook.com/${version}/me/adaccounts?fields=id,name,account_status,currency&limit=100`;let pages=0;const accounts=[];
 while(url&&pages++<15){const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});const payload=await response.json();if(!response.ok)throw Error(payload.error?.message||'Meta connection failed');accounts.push(...(payload.data||[]));url=payload.paging?.next||null;}
 // No implicit account mapping: admin must explicitly assign discovered Meta IDs to CI-01..CI-10.
 res.json({discovered:accounts.map(a=>({id:a.id,name:a.name,status:a.account_status,currency:a.currency}))});
}));
app.post('/api/meta/map-account',admin,handler(async(req,res)=>{
 const {slot,meta_account_id,meta_account_name}=req.body;
 if(!Number.isInteger(slot)||slot<1||slot>10||!/^act_\d+$/.test(meta_account_id||''))return fail(res,400,'Invalid account number or Meta ID');
 const duplicate=await result(db.from('ad_accounts').select('slot').eq('meta_account_id',meta_account_id).neq('slot',slot));if(duplicate.length)return fail(res,409,'Meta account already mapped');
 const rows=await result(db.from('ad_accounts').update({meta_account_id,meta_account_name:typeof meta_account_name==='string'?meta_account_name.slice(0,200):null}).eq('slot',slot).select());
 if(!rows.length)return fail(res,404,'Slot not found');res.json({account:rows[0]});
}));
app.use('/api',(_req,res)=>fail(res,404,'API route not found'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../dist');
app.use(express.static(root,{index:false}));
app.get('*',(_req,res)=>res.sendFile(path.join(root,'index.html'),err=>{if(err&&!res.headersSent)res.status(404).send('Build the frontend first: npm run build');}));
app.use((err,req,res,next)=>{console.error('API error:',err.message);if(!res.headersSent)fail(res,500,'Request failed. Check server logs.');});
app.listen(PORT,'0.0.0.0',()=>console.log(`CI Ads Manager on ${PORT}`));
