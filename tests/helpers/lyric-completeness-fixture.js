export const completenessTarget={title:'Fixture Song',artist:'Fixture Singer',album:'Fixture Album',duration:240};
export const opening=[
 'The morning opens every window and the quiet streets begin to shine',
 'We carry all the stories that we gathered on the journey home',
 'Beyond the river there is somewhere we have never been before',
 'And every time the chorus comes we sing together once again'
];
export const laterVerse=[
 'The evening brings a different promise underneath a distant sky',
 'A letter waits upon the table with the words we could not say',
 'Tomorrow we will leave the station and discover something new',
 'Until the final bridge has ended we will keep the lantern bright'
];
export function completenessCandidate({id='excerpt',lines=opening,timed=true,target=completenessTarget,...rest}={}) {
 return {song:{id,...target},target,lyrics:{lines:lines.map((text,index)=>({text,timestamp:timed?10+index*15:null}))},...rest};
}
export const fullerCandidate=()=>completenessCandidate({id:'full',lines:[...opening,...laterVerse,...opening],timed:false});
