export function logLookup(logger,event,details) {
 logger.info?.(event,logger===console?JSON.stringify(details):details);
}
