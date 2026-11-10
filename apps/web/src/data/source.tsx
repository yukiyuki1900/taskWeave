import { createContext, useContext } from 'react';
import { client as liveClient } from './client.ts';
import type { ReadClient } from './client.ts';

export interface DataSource {
  mode: 'live' | 'demo';
  client: ReadClient;
}
export const DataSourceContext = createContext<DataSource>({ mode: 'live', client: liveClient });
export const useDataSource = () => useContext(DataSourceContext);
