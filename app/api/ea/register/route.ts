import {eaRequest} from '../../../../server/http.mjs';
import {after} from 'next/server';
export const runtime='nodejs';
export const maxDuration=60;
export const POST=(req:Request)=>eaRequest(req,true,{schedule:(task:()=>Promise<unknown>)=>after(task)});
