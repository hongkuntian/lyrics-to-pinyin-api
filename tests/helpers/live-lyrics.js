export const pushTime=1791061200000;
export function pushBody(sequence=1, time=pushTime) {
  return {activityID:'fixture-activity',token:'ab'.repeat(32),environment:'development',reason:'content',
    state:{recordingID:'recording',title:'Lyra',artist:'Singer',lineID:'line',original:'无需太多的伤悲',
      pronunciation:'wú xū tài duō de shāng bēi',translation:'There is no need for so much sorrow.',nextOriginal:'',
      rubyReadings:[],pronunciationAbove:true,centered:false,progress:0,part:0,parts:1,phase:'lyrics',playing:true,
      observedAt:time/1000-978307200,sequence}};
}
