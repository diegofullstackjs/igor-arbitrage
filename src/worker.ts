import { parentPort, workerData } from "worker_threads";
import { monitorOpportunities } from "./arbitrage";

async function startMonitoring() {
    const opportunities = await monitorOpportunities(
        workerData.exchanges,
        workerData.symbols,
        workerData.minVolume,
        workerData.minProfit,
        workerData.maxProfit,
        1000,
        workerData.stopLossPercent,
        workerData.stopLossTimeout
    );
    if (opportunities.length > 0) {
        parentPort?.postMessage(opportunities);
    }
     parentPort?.postMessage(`Sem oportunidades ${opportunities}`);
}

startMonitoring();