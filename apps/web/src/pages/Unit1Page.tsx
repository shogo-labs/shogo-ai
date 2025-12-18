import { HostMSTDemo } from '../components/Unit1_HostDemo/HostMSTDemo'

export function Unit1Page() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-2">Unit 1: Host MST Demo</h1>
      <p className="text-muted-foreground mb-6">Testing MST observer pattern in host app (no Sandpack complexity)</p>
      <HostMSTDemo />
    </div>
  )
}
