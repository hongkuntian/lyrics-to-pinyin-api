import {database} from '../song-library/database.js';
import {SpotifyStore} from '../spotify/store.js';
import {createSpotifyRuntime} from '../spotify/runtime.js';
import {ListeningService} from './service.js';
import {ListeningStore} from './store.js';
import {ListeningSpotify} from './spotify.js';
export function createListeningRuntime({db=database(),env=process.env,...overrides}={}){
 return new ListeningService({store:new ListeningStore(db,env.VERCEL_ENV??'development'),spotify:new ListeningSpotify({broker:()=>createSpotifyRuntime({env,store:new SpotifyStore(db)})}),...overrides});
}
