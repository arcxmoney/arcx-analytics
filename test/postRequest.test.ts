import { expect } from 'chai'
import sinon from 'sinon'
import { postRequest } from '../src/helpers'
import { TEST_API_KEY } from './fixture'

describe('(unit) postRequest', () => {
  it('calls fetch with the given arguments', async () => {
    global.fetch = sinon.stub().resolves({
      async json() {
        return 'test response'
      },
    } as any)

    const data = {
      a: 'a',
      b: 5,
      c: {
        d: 'd',
        e: {
          f: 'f',
        },
      },
    }
    const res = await postRequest('https://example.com/', TEST_API_KEY, 'v1', data)

    expect(res).to.equal('test response')
    expect(global.fetch).to.have.been.calledOnceWithExactly('https://example.com/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'x-api-key': TEST_API_KEY,
      },
      body: JSON.stringify(data),
    })

    global.fetch = undefined as any
  })
})