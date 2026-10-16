import {QueueClient} from '@vercel/queue';
export const topics={tick:'spotify-background-tick-v1',acquire:'spotify-background-acquire-v1'};
export const queue=new QueueClient({region:'iad1'});
export const enqueue=(kind,message,options)=>queue.send(topics[kind],message,options);
export const callbackOptions={visibilityTimeoutSeconds:30,retry:(error,metadata)=>({afterSeconds:Math.min(300,2**Math.min(7,metadata.deliveryCount))})};
