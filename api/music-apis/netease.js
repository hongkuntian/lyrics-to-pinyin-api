import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {findRecording} from '../utils/recording-match.js';
export class NeteaseAPI extends BaseMusicAPI {
  constructor() { super('NeteaseAPI',['zh','yue','en']); this.baseURL='https://netease-cloud-music-api-gules-mu.vercel.app'; }
  async searchSong(artist,title,context={}) {
    const data=await fetchJSON(`${this.baseURL}/search?limit=30&keywords=${encodeURIComponent(`${artist} ${title}`)}`,context);
    if(data.code!==200) throw new Error('NetEase search unavailable');
    const songs=(data.result?.songs || []).map(song=>({id:song.id,title:song.name,artist:song.artists?.map(x=>x.name).join(' & ') || '',album:song.album?.name,duration:song.duration ? song.duration/1000:null,source:'netease'}));
    return findRecording(songs,{artist,title,...context});
  }
  async getLyrics(id,context={}) {
    const data=await fetchJSON(`${this.baseURL}/lyric?id=${id}`,context);
    if(data.code!==200) throw new Error('NetEase lyrics unavailable');
    return data.lrc?.lyric ? {lines:this.parseLyrics(data.lrc.lyric),source:'netease',songId:id}:null;
  }
  parseLyrics(raw) { return parseLRC(raw); }
}
