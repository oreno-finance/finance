import {LiveVault as ProductionVault} from '../../dist/src/cloud/live-vault.js';
import {VaultOperationBusyError} from '../../dist/src/cloud/onedrive-api.js';
export * from '../../dist/src/cloud/live-vault.js';
const active=new WeakMap();
// Existing encrypted-storage fixtures model completed synchronous writes and
// ETags. Add the same exclusive operation boundary, shared by mock devices.
export class LiveVault extends ProductionVault {
  constructor(client){
    if(typeof client.acquireVaultMutation!=='function'){
      const store=client.store??client.shared??client.state??client.data??client.rows??client.files??client.items??client;
      Object.defineProperty(client,'acquireVaultMutation',{value:async()=>{
        if(active.has(store))throw new VaultOperationBusyError();
        const token={};active.set(store,token);
        return async()=>{if(active.get(store)!==token)throw new Error('fixture lock changed');active.delete(store);};
      }});
    }
    super(client);
  }
}
