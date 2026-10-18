import {QueueClient} from '@vercel/queue';
export const listeningQueue=new QueueClient({region:'iad1'});
export const listeningTopic='lyrica-listening-session-v1';
export const enqueueListening=(message,options)=>listeningQueue.send(listeningTopic,message,options);
