import Link from "next/link";
import catalog from "../../../shared/alert-catalog.json";
import {stamp,type AlertSummary} from "@/lib/model";
import {Card,CardHeader,CardTitle,CardContent} from "@/components/ui/card";
const entry=(code:string)=>Object.hasOwn(catalog,code)?catalog[code as keyof typeof catalog]:{title:"Operational issue",detail:"Check worker status and deployment logs.",path:"/automation"};
function emailState(state:string|null) {
  return state==="accepted"?"Email accepted by provider":state==="rejected"?"Email rejected — check delivery configuration":
    state==="unknown"?"Email outcome unknown — check provider logs":state==="sending"?"Email attempt recorded":"Email not attempted";
}
export function OperationalAlerts({data}:{data:AlertSummary}) {
  const {active,history,monitor}=data;
  return <Card className="operational-alerts" id="alerts">
    <CardHeader><CardTitle>Needs your attention</CardTitle></CardHeader>
    <CardContent>
      {active.length?<ul className="incident-list">{active.map(({code})=>{
        const message=entry(code);
        return <li key={code}><strong>{message.title}</strong><p>{message.detail}</p><Link className="inline-link" href={message.path}>View details →</Link></li>;
      })}</ul>:<p className="control-state control-running">No operational issues detected</p>}
      <div className="alert-delivery">
        <strong>{monitor.email_configured?"Email alerts enabled":"Email alerts need setup"}</strong>
        <p>{monitor.email_configured?"New incidents are grouped into one digest. The same unresolved issue is emailed once.":"Issues remain visible here. Add the private sender, recipient and email key to enable delivery."}</p>
        <p>At most 1 email attempt per UTC day and 5 per UTC month. Used: {monitor.daily_attempts}/1 today · {monitor.monthly_attempts}/5 this month.</p>
        {monitor.daily_attempts>=1||monitor.monthly_attempts>=5?<p>New incidents wait for the next available email allowance. Resolved issues are removed before sending.</p>:null}
        {monitor.last_email_state&&<p>{emailState(monitor.last_email_state)}. Acceptance does not confirm inbox delivery. Failed or uncertain attempts are not automatically resent.</p>}
        <small>Last alert check: {stamp(monitor.last_checked_at)}. Dashboard conditions are checked when you load this page.</small>
      </div>
      {history.length>0&&<details className="incident-history"><summary>Incident history ({history.length}{history.length===50?" most recent":""})</summary>
        <ol className="revision-list">{history.map(i=><li key={i.id}><div><strong>{entry(i.code).title}</strong>
          <small>First seen {stamp(i.first_seen_at)} · {i.resolved_at?`Cleared ${stamp(i.resolved_at)}`:active.some(x=>x.code===i.code)?"Active at last check":"Clear now; history updates at the next scheduled check"}</small>
          <small>{emailState(i.email_state)}</small></div></li>)}</ol>
      </details>}
    </CardContent>
  </Card>;
}
