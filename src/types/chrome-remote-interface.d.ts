declare module 'chrome-remote-interface' {
  interface CdpOptions {
    host?: string;
    port?: number;
    target?: string | ((targets: any[]) => any);
    local?: boolean;
  }

  interface CdpClient {
    Page: any;
    Runtime: any;
    Input: any;
    DOM: any;
    Network: any;
    Accessibility: any;
    Target: any;
    close(): Promise<void>;
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
    target: string;
  }

  function CDP(options: CdpOptions): Promise<CdpClient>;

  namespace CDP {
    function List(options: { host: string; port: number }): Promise<any[]>;
    function Version(options: { host: string; port: number }): Promise<any>;
  }

  export = CDP;
}
