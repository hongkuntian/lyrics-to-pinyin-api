import {createSpotifyHandler} from './spotify.js';
export const config={maxDuration:30};
// Explicit platform rewrites select the canonical endpoint. Neither handler
// accepts extra account/provider authority from this routing parameter.
export function createProviderGateway({spotify=createSpotifyHandler()}={}){
 return (req,res)=>{
  if(req.query?._lyrica_endpoint==='spotify')return spotify(req,res);
  res.setHeader('Cache-Control','private, no-store');return res.status(404).json({version:1,code:'not_found'});
 };
}
export default createProviderGateway();
