export const annotationBrackets=[['(',')'],['[',']'],['（','）'],['［','］']];
export const soundtrackDescriptions=['From "Example Film"','Theme Song From Example Film','电影《示例电影》主题曲','電影《示例電影》主題曲','抖音熱歌'];
const source={id:'1',title:'Song',artist:'Singer',album:'Album',duration:188};
export function recordingTransformations() {
 const cases=[];
 for(const policy of ['legacy','spotify']) {
  const request={...source,catalog_id:'123',...(policy==='spotify'?{recordingProvider:'spotify',creditedArtistNames:['Singer']}: {})};
  for(const [open,close] of annotationBrackets)for(const description of soundtrackDescriptions)for(const spacing of ['',' ','  ']) {
   const title=`Song${spacing}${open}${description}${close}`;
   cases.push({label:`${policy}:${title}`,song:{...source},request:{...request,title},accepted:true});
   for(const change of [{artist:'Other Singer'},{artist:'Singer & Guest'},{title:'Song (Live)'},{duration:191.001},{explicit:true}])
    cases.push({label:`${policy}:${title}:${JSON.stringify(change)}`,song:{...source,...change},request:{...request,title,explicit:false},accepted:false});
  }
  for(const [open,close] of annotationBrackets)for(const marker of ['Live','Remastered','Instrumental','Acoustic','feat. Guest','with Guest','合唱','伴奏'])
   cases.push({label:`${policy}:material:${open}${marker}${close}`,song:{...source},request:{...request,title:`Song ${open}From Example Film - ${marker}${close}`},accepted:false});
  for(const title of ['Song [Unknown Subtitle]','Song [From Film)','Song (From Film]','Song [[From Film]]','Song [From (Film)]','Song [From Film','Song [From\nFilm]'])
   cases.push({label:`${policy}:unknown:${title}`,song:{...source},request:{...request,title},accepted:false});
  for(const delta of [-3,-0.5,0,0.5,3,3.001])
   cases.push({label:`${policy}:duration:${delta}`,song:{...source,duration:188+delta},request,accepted:Math.abs(delta)<=3});
  cases.push({label:`${policy}:unknown-duration`,song:{...source,duration:undefined},request,accepted:policy==='legacy'});
  cases.push({label:`${policy}:isrc-conflict`,song:{...source,isrc:'USAAA2600001'},request:{...request,isrc:'USAAA2600002'},accepted:policy==='legacy'});
  cases.push({label:`${policy}:unknown-version-prose`,song:{...source,album:'Live Through Tomorrow'},request,accepted:policy==='spotify'});
 }
 return cases;
}
