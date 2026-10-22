import {eaRequest} from '../../../../server/http.mjs';
export const runtime='nodejs';
export const POST=(req:Request)=>eaRequest(req,true);
