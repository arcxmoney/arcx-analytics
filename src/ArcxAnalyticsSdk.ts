import {
  Account,
  Attributes,
  ChainID,
  SdkConfig,
  TransactionHash,
  RequestArguments,
  EIP1193Provider,
} from './types'
import {
  ATTRIBUTION_EVENT,
  CHAIN_CHANGED_EVENT,
  TRANSACTION_TRIGGERED,
  CONNECT_EVENT,
  CURRENT_URL_KEY,
  DEFAULT_SDK_CONFIG,
  DISCONNECT_EVENT,
  FIRST_PAGE_VISIT,
  IDENTITY_KEY,
  PAGE_EVENT,
  REFERRER_EVENT,
  TRANSACTION_EVENT,
  SIGNING_EVENT,
  CLICK_EVENT,
  SDK_VERSION,
} from './constants'
import { createClientSocket, getElementsFullInfo, postRequest } from './utils'
import { Socket } from 'socket.io-client'
import { inspect } from 'util'

export class ArcxAnalyticsSdk {
  /* --------------------------- Private properties --------------------------- */
  private _provider?: EIP1193Provider
  private _originalRequest?: EIP1193Provider['request']
  private _registeredProviderListeners: Record<string, (...args: unknown[]) => void> = {}

  /* ---------------------------- Public properties --------------------------- */
  currentChainId?: string | null
  currentConnectedAccount?: string

  get provider(): EIP1193Provider | undefined {
    return this._provider
  }

  private constructor(
    public readonly apiKey: string,
    public readonly identityId: string,
    private readonly sdkConfig: SdkConfig,
    private readonly socket: Socket,
  ) {
    this.setProvider(sdkConfig.initialProvider || window?.ethereum || window.web3?.currentProvider)

    if (this.sdkConfig.trackPages) {
      this._trackPagesChange()
    }

    if (this.sdkConfig.trackClicks) {
      this._trackClicks()
    }

    this._registerSocketListeners(socket)

    this._trackFirstPageVisit()
  }

  /**********************/
  /** INTERNAL METHODS **/
  /**********************/

  private _registerSocketListeners(socket: Socket) {
    socket.on('error', (error) => {
      console.error('error event received from socket', error)
    })
  }

  private _registerAccountsChangedListener() {
    const listener = (...args: unknown[]) => this._onAccountsChanged(args[0] as string[])

    this._provider?.on('accountsChanged', listener)
    this._registeredProviderListeners['accountsChanged'] = listener

    const _handleAccountDisconnected = this._handleAccountDisconnected.bind(this)
    this._provider?.on('disconnect', _handleAccountDisconnected)
    this._registeredProviderListeners['disconnect'] = _handleAccountDisconnected
  }

  private _registerChainChangedListener() {
    const listener = (...args: unknown[]) => this._onChainChanged(args[0] as string)
    this.provider?.on('chainChanged', listener)
    this._registeredProviderListeners['chainChanged'] = listener
  }

  private _trackFirstPageVisit() {
    if (!this.sdkConfig.trackPages && !this.sdkConfig.trackReferrer && !this.sdkConfig.trackUTM) {
      return
    }

    const attributes: FirstVisitPageType = {}

    if (this.sdkConfig.trackPages) {
      attributes.url = window.location.href
      if (sessionStorage.getItem(CURRENT_URL_KEY) === null) {
        sessionStorage.setItem(CURRENT_URL_KEY, window.location.href)
      }
    }

    if (this.sdkConfig.trackReferrer) {
      attributes.referrer = document.referrer
    }

    if (this.sdkConfig.trackUTM) {
      const searchParams = new URLSearchParams(
        window.location.search || window.location.hash.split('?')[1],
      )

      attributes.utm = {
        source: searchParams.get('utm_source'),
        medium: searchParams.get('utm_medium'),
        campaign: searchParams.get('utm_campaign'),
      }
    }

    return this.event(FIRST_PAGE_VISIT, attributes)
  }

  private _trackPagesChange() {
    const oldPushState = history.pushState
    history.pushState = function pushState(...args) {
      const ret = oldPushState.apply(this, args)
      window.dispatchEvent(new window.Event('locationchange'))
      return ret
    }

    const oldReplaceState = history.replaceState
    history.replaceState = function replaceState(...args) {
      const ret = oldReplaceState.apply(this, args)
      window.dispatchEvent(new window.Event('locationchange'))
      return ret
    }

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new window.Event('locationchange'))
    })

    window.addEventListener('locationchange', () => this._onLocationChange())
  }

  private _onLocationChange() {
    const currentUrl = sessionStorage.getItem(CURRENT_URL_KEY)

    if (currentUrl !== window.location.href) {
      sessionStorage.setItem(CURRENT_URL_KEY, window.location.href)
      this.page({ url: window.location.href })
    }
  }

  private async _onAccountsChanged(accounts: string[]) {
    if (accounts.length > 0) {
      this._handleAccountConnected(accounts[0])
    } else {
      this._handleAccountDisconnected()
    }
  }

  private async _handleAccountConnected(account: string) {
    if (account === this.currentConnectedAccount) {
      // We have already reported this account
      return
    } else {
      this.currentConnectedAccount = account
    }

    this.currentChainId = await this._getCurrentChainId()

    return this.connectWallet({ chain: this.currentChainId, account: account })
  }

  private _handleAccountDisconnected() {
    if (!this.currentChainId || !this.currentConnectedAccount) {
      this._report(
        'warning',
        'ArcxAnalyticsSdk::_handleAccountDisconnected: previousChainId or previousConnectedAccount is not set',
      )
      /**
       * It is possible that this function has already been called once and the cached values
       * have been cleared. This can happen in the following scenario:
       * 1. Initialize ArcxAnalyticsProvider with the default config (sets MM as the initial provider)
       * 2. Connect WalletConnect
       * 3. Disconnect
       *
       * TODO: solve this case in https://github.com/arcxmoney/analytics-sdk/issues/124
       */
      return
    }

    const disconnectAttributes = {
      account: this.currentConnectedAccount,
      chain: this.currentChainId,
    }
    this.currentChainId = undefined
    this.currentConnectedAccount = undefined

    return this.event(DISCONNECT_EVENT, disconnectAttributes)
  }

  private _onChainChanged(chainIdHex: string) {
    this.currentChainId = parseInt(chainIdHex, 16).toString()

    return this.event(CHAIN_CHANGED_EVENT, { chain: this.currentChainId })
  }

  private async _reportCurrentWallet() {
    if (!this.provider) {
      console.warn('ArcxAnalyticsSdk::_reportCurrentWallet: the provider is not set')
      return
    }

    const accounts = await this.provider.request<string[]>({ method: 'eth_accounts' })

    if (accounts && accounts.length > 0 && accounts[0]) {
      this._handleAccountConnected(accounts[0])
    }
  }

  private async _getCurrentChainId(): Promise<string> {
    if (!this.provider) {
      this._reportErrorAndThrow('ArcxAnalyticsSdk::_getCurrentChainId: provider not set')
    }

    const chainIdHex = await this.provider.request<string>({ method: 'eth_chainId' })
    // Because we're connected, the chainId cannot be null
    if (!chainIdHex) {
      this._reportErrorAndThrow(
        `ArcxAnalyticsSdk::_getCurrentChainId: chainIdHex is: ${chainIdHex}`,
      )
    }

    return parseInt(chainIdHex, 16).toString()
  }

  /*
    Sent object in eth_sendTransaction is describe under link below:
    https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_sendtransaction
  */
  private _trackTransactions(): boolean {
    const provider = this.provider
    if (!provider) {
      this._report('error', 'ArcxAnalyticsSdk::_trackTransactions: provider not found')
      return false
    }

    if (Object.getOwnPropertyDescriptor(provider, 'request')?.writable === false) {
      this._report(
        'warning',
        'ArcxAnalyticsSdk::_trackTransactions: provider.request is not writable',
        { provider: inspect(this.provider) },
      )
      return false
    }

    // Deliberately not using this._original request to not intefere with the signature tracking's
    // request modification
    const request = provider.request.bind(provider)
    provider.request = async ({ method, params }: RequestArguments) => {
      if (Array.isArray(params) && method === 'eth_sendTransaction') {
        const transactionParams = params[0]
        const nonce = await provider.request({
          method: 'eth_getTransactionCount',
          params: [transactionParams.from, 'latest'],
        })

        this.event(TRANSACTION_TRIGGERED, {
          ...transactionParams,
          nonce,
        })
      }
      return request({ method, params })
    }

    return true
  }

  private _trackSigning() {
    if (!this.provider) {
      this._report('error', 'ArcxAnalyticsSdk::_trackTransactions: provider not found')
      return false
    }

    if (Object.getOwnPropertyDescriptor(this.provider, 'request')?.writable === false) {
      this._report(
        'warning',
        'ArcxAnalyticsSdk::_trackTransactions: provider.request is not writable',
        { provider: inspect(this.provider) },
      )
      return false
    }

    // Deliberately not using this._original request to not intefere with the transaction tracking's
    // request modification
    const request = this.provider.request.bind(this.provider)
    this.provider.request = async ({ method, params }: RequestArguments) => {
      if (Array.isArray(params)) {
        if (['signTypedData_v4', 'eth_sign'].includes(method)) {
          this.event(SIGNING_EVENT, {
            account: params[0],
            messageToSign: params[1],
          })
        }
        if (method === 'personal_sign') {
          this.event(SIGNING_EVENT, {
            messageToSign: params[0],
            account: params[1],
            password: params[2],
          })
        }
      }
      return request({ method, params })
    }
    return true
  }

  private _trackClicks() {
    window.addEventListener('click', (event: MouseEvent) => {
      if (event.target instanceof Element) {
        this.event(CLICK_EVENT, {
          elementId: getElementsFullInfo(event.target),
          content: event.target.textContent,
        })
      } else {
        this._report('warning', 'ArcxAnalyticsSdk::_trackClicks: event target is not Element')
      }
    })
  }

  private _initializeWeb3Tracking() {
    if (this.provider) {
      if (this.sdkConfig.trackWalletConnections) {
        this._reportCurrentWallet()
        this._registerAccountsChangedListener()
      }

      if (this.sdkConfig.trackChainChanges) {
        this._registerChainChangedListener()
      }

      if (this.sdkConfig.trackSigning) {
        this._trackSigning()
      }

      if (this.sdkConfig.trackTransactions) {
        this._trackTransactions()
      }
    }
  }

  /** Report error to the server in order to better understand edge cases which can appear */
  _report(
    logLevel: 'error' | 'log' | 'warning',
    msg: string,
    additionalInfo?: Record<string, unknown>,
  ): Promise<string> {
    return postRequest(this.sdkConfig.url, this.apiKey, '/log-sdk', {
      logLevel,
      data: {
        msg,
        identityId: this.identityId,
        apiKey: this.apiKey,
        ...(additionalInfo ? { additionalInfo } : {}),
      },
    })
  }

  /** Report error to the server and throw an error */
  _reportErrorAndThrow(error: string): never {
    this._report('error', error)
    throw new Error(error)
  }

  /********************/
  /** PUBLIC METHODS **/
  /********************/

  /**
   * Sets a new provider. If automatic EVM events tracking is enabled,
   * the registered listeners will be removed from the old provider and added to the new one.
   */
  setProvider(provider: EIP1193Provider | undefined) {
    if (provider === this._provider) {
      return
    }

    this.currentChainId = undefined
    this.currentConnectedAccount = undefined

    if (this._provider) {
      const eventNames = Object.keys(this._registeredProviderListeners)
      for (const eventName of eventNames) {
        this._provider.removeListener(eventName, this._registeredProviderListeners[eventName])
        delete this._registeredProviderListeners[eventName]
      }

      // Restore original request
      if (
        this._originalRequest &&
        Object.getOwnPropertyDescriptor(this._provider, 'request')?.writable !== false
      ) {
        this._provider.request = this._originalRequest
      }
    }

    this._provider = provider
    this._originalRequest = provider?.request

    this._initializeWeb3Tracking()
  }

  /** Initialises the Analytics SDK with desired configuration. */
  static async init(apiKey: string, config?: Partial<SdkConfig>): Promise<ArcxAnalyticsSdk> {
    const sdkConfig = { ...DEFAULT_SDK_CONFIG, ...config }

    const identityId =
      (sdkConfig?.cacheIdentity && window.localStorage.getItem(IDENTITY_KEY)) ||
      (await postRequest(sdkConfig.url, apiKey, '/identify'))
    sdkConfig?.cacheIdentity && window.localStorage.setItem(IDENTITY_KEY, identityId)

    const websocket = createClientSocket(sdkConfig.url, {
      apiKey,
      identityId,
      sdkVersion: SDK_VERSION,
    })

    return new ArcxAnalyticsSdk(apiKey, identityId, sdkConfig, websocket)
  }

  /** Generic event logging method. Allows arbitrary events to be logged. */
  event(event: string, attributes?: Attributes) {
    // If the socket is not connected, the event will be buffered until reconnection and sent then
    this.socket.emit('submit-event', {
      event,
      attributes,
    })
  }

  /**
   * Logs attribution information.
   *
   * @remark
   * You can optionally attribute either:
   * - the `source` that the traffic originated from (e.g. `discord`, `twitter`)
   * - the `medium`, defining the medium your visitors arrived at your site
   * (e.g. `social`, `email`)
   * - the `campaign` if you wish to track a specific marketing campaign
   * (e.g. `bankless-podcast-1`, `discord-15`)
   */
  attribute(attributes: {
    source?: string
    medium?: string
    campaign?: string
    [key: string]: unknown
  }): void {
    return this.event(ATTRIBUTION_EVENT, attributes)
  }

  /** Logs page visit events. Only use this method is `trackPages` is set to `false`. */
  page(attributes: { url: string }): void {
    if (!attributes.url) {
      throw new Error('ArcxAnalyticsSdk::page: url cannot be empty')
    }
    return this.event(PAGE_EVENT, attributes)
  }

  /** Logs a wallet connect event. */
  connectWallet(attributes: { chain: ChainID; account: Account }): void {
    return this.event(CONNECT_EVENT, attributes)
  }

  /** Logs an on-chain transaction made by an account. */
  transaction(attributes: {
    chain: ChainID
    transactionHash: TransactionHash
    metadata?: Record<string, unknown>
  }) {
    return this.event(TRANSACTION_EVENT, {
      chain: attributes.chain,
      transaction_hash: attributes.transactionHash,
      metadata: attributes.metadata || {},
    })
  }

  /** Logs an refferer of html page. */
  async referrer(referrer?: string) {
    return this.event(REFERRER_EVENT, { referrer: referrer || document.referrer })
  }
}

type FirstVisitPageType = {
  url?: string
  referrer?: string
  utm?: {
    source: string | null
    medium: string | null
    campaign: string | null
  }
}
