/** Agora's first-party, dependency-free sandbox client. Server-side only. */
export type Product={id:string;name:string;description:string;amount:number;currency:'usd';created_at:string};
export type Payment={id:string;product_id:string;product_name:string;customer:string;amount:number;refunded:number;currency:'usd';status:'pending'|'succeeded'|'failed';created_at:string};
export type Page<T>={data:T[];next_cursor:number|null};
export type MutationOptions={idempotencyKey:string};
export class AgoraError extends Error{constructor(message:string,public code:string,public status:number,public requestId?:string){super(message);this.name='AgoraError'}}
export class Agora{
 private readonly baseUrl:string;private readonly apiKey:string;
 constructor(options:{apiKey:string;baseUrl:string}){const url=new URL(options.baseUrl);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&(url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname.endsWith('.localhost'))))throw new Error('Use HTTPS, except for localhost development.');this.baseUrl=url.origin;this.apiKey=options.apiKey;}
 private async request<T>(method:string,path:string,body?:unknown,options?:MutationOptions):Promise<T>{if(method==='POST'&&!options?.idempotencyKey)throw new Error('An idempotencyKey is required for writes. Reuse it when retrying the same operation.');const response=await fetch(`${this.baseUrl}/api/v1/${path}`,{method,headers:{Authorization:`Bearer ${this.apiKey}`,...(body?{'Content-Type':'application/json'}:{}),...(options?{'Idempotency-Key':options.idempotencyKey}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const result=await response.json() as {error?:{message?:string;code?:string;request_id?:string}};if(!response.ok)throw new AgoraError(result.error?.message||'Request failed',result.error?.code||'request_failed',response.status,result.error?.request_id);return result as T;}
 products={list:(cursor=0)=>this.request<Page<Product>>('GET',`products?cursor=${cursor}`),create:(data:{name:string;amount:number;description?:string;currency?:'usd'},options:MutationOptions)=>this.request<Product>('POST','products',data,options)};
 payments={list:(cursor=0)=>this.request<Page<Payment>>('GET',`payments?cursor=${cursor}`),get:(id:string)=>this.request<Payment>('GET',`payments/${encodeURIComponent(id)}`),create:async(data:{product_id:string;customer?:string},options:MutationOptions)=>{const p=await this.request<Payment&{checkout_url:string}>('POST','payments',data,options);return{...p,checkout_url:new URL(p.checkout_url,this.baseUrl).href}}};
 refunds={create:(data:{payment_id:string;amount:number;reason:string},options:MutationOptions)=>this.request<{id:string;status:'succeeded'|'requires_approval';amount:number}>('POST','refunds',data,options)};
 events={list:(cursor=0)=>this.request<Page<{id:string;type:string;actor:string;object_id:string;data:Record<string,unknown>;created_at:string}>>('GET',`events?cursor=${cursor}`)};
}
