/* eslint-disable global-require */

function readRangeFromBlocks(blocks, rangeOffset, rangeLength) {
  const rangeTop = rangeOffset + rangeLength;
  const rangeData = new ArrayBuffer(rangeLength);
  const rangeView = new Uint8Array(rangeData);

  for (const block of blocks) {
    const delta = block.offset - rangeOffset;
    const topDelta = block.top - rangeTop;
    let blockInnerOffset = 0;
    let rangeInnerOffset = 0;
    let usedBlockLength;

    if (delta < 0) {
      blockInnerOffset = -delta;
    } else if (delta > 0) {
      rangeInnerOffset = delta;
    }

    if (topDelta < 0) {
      usedBlockLength = block.length - blockInnerOffset;
    } else if (topDelta > 0) {
      usedBlockLength = rangeTop - block.offset - blockInnerOffset;
    }

    const blockView = new Uint8Array(block.data, blockInnerOffset, usedBlockLength);
    rangeView.set(blockView, rangeInnerOffset);
  }

  return rangeData;
}

/**
 * @typedef {object} Block
 * @property {ArrayBuffer} data The actual data of the block.
 * @property {number} offset The actual offset of the block within the file.
 * @property {number} length The actual size of the block in bytes.
 */

/**
 * Callback type for sources to request patches of data.
 * @callback requestCallback
 * @async
 * @param {number} offset The offset within the file.
 * @param {number} length The desired length of data to be read.
 * @returns {Promise<Block>} The block of data.
 */

/*
 * Split a list of identifiers to form groups of coherent ones
 */
function getCoherentBlockGroups(blockIds) {
  if (blockIds.length === 0) {
    return [];
  }

  const groups = [];
  let current = [];
  groups.push(current);

  for (let i = 0; i < blockIds.length; ++i) {
    if (i === 0 || blockIds[i] === blockIds[i - 1] + 1) {
      current.push(blockIds[i]);
    } else {
      current = [blockIds[i]];
      groups.push(current);
    }
  }
  return groups;
}


/*
 * Promisified wrapper around 'setTimeout' to allow 'await'
 */
async function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * BlockedSource - an abstraction of (remote) files.
 */
class BlockedSource {
  /**
   * @param {requestCallback} retrievalFunction Callback function to request data
   * @param {object} options Additional options
   * @param {object} options.blockSize Size of blocks to be fetched
   */
  constructor(retrievalFunction, { blockSize = 65535 } = {}) {
    this.retrievalFunction = retrievalFunction;
    this.blockSize = blockSize;

    // currently running block requests
    this.blockRequests = new Map();

    // already retrieved blocks
    this.blocks = new Map();

    // block ids waiting for a batched request. Either a Set or null
    this.blockIdsAwaitingRequest = null;
  }

  /**
   * Fetch a subset of the file.
   * @param {number} offset The offset within the file to read from.
   * @param {number} length The length in bytes to read from.
   * @returns {ArrayBuffer} The subset of the file.
   */
  async fetch(offset, length, immediate = false) {
    const top = offset + length;

    // calculate what blocks intersect the specified range (offset + length)
    // determine what blocks are already stored or beeing requested
    const firstBlockOffset = Math.floor(offset / this.blockSize) * this.blockSize;
    const allBlockIds = [];
    const missingBlockIds = [];
    for (let current = firstBlockOffset; current < top; current += this.blockSize) {
      const blockId = Math.floor(current / this.blockSize);
      if (!this.blocks.has(blockId) && !this.blockRequests.has(blockId)) {
        missingBlockIds.push(blockId);
      }
      allBlockIds.push(blockId);
    }

    // determine whether there are already blocks in the queue to be requested
    // if so, add the missing blocks to this list
    if (!this.blockIdsAwaitingRequest) {
      this.blockIdsAwaitingRequest = new Set(missingBlockIds);
    } else {
      for (let i = 0; i < missingBlockIds.length; ++i) {
        const id = missingBlockIds[i];
        this.blockIdsAwaitingRequest.add(id);
      }
    }

    // in immediate mode, we don't want to wait for possible additional requests coming in
    if (!immediate) {
      await wait();
    }

    // determine if we are the thread to start the requests.
    if (this.blockIdsAwaitingRequest) {
      // get all coherent blocks as groups to be requested in a single request
      const groups = getCoherentBlockGroups(
        Array.from(this.blockIdsAwaitingRequest).sort(),
      );

      // iterate over all blocks
      for (const group of groups) {
        // fetch a group as in a single request
        const request = this.requestData(
          group[0] * this.blockSize, group.length * this.blockSize,
        );

        // for each block in the request, make a small 'splitter',
        // i.e: wait for the request to finish, then cut out the bytes for
        // that block and store it there.
        // we keep that as a promise in 'blockRequests' to allow waiting on
        // a single block.
        for (let i = 0; i < group.length; ++i) {
          const id = group[i];
          this.blockRequests.set(id, (async () => {
            const response = await request;
            const o = i * this.blockSize;
            const t = Math.min(o + this.blockSize, response.data.byteLength);
            const data = response.data.slice(o, t);
            this.blockRequests.delete(id);
            this.blocks.set(id, {
              data,
              offset: response.offset + o,
              length: data.byteLength,
              top: response.offset + t,
            });
          })());
        }
      }
      this.blockIdsAwaitingRequest = null;
    }

    // get a list of currently running requests for the blocks still missing
    const missingRequests = [];
    for (const blockId of missingBlockIds) {
      if (this.blockRequests.has(blockId)) {
        missingRequests.push(this.blockRequests.get(blockId));
      }
    }

    // wait for all missing requests to finish
    await Promise.all(missingRequests);

    // now get all blocks for the request and return a summary buffer
    const blocks = allBlockIds.map(id => this.blocks.get(id));
    return readRangeFromBlocks(blocks, offset, length);
  }

  async requestData(requestedOffset, requestedLength) {
    const response = await this.retrievalFunction(requestedOffset, requestedLength);
    if (!response.length) {
      response.length = response.data.byteLength;
    } else if (response.length !== response.data.byteLength) {
      response.data = response.data.slice(0, response.length);
    }
    response.top = response.offset + response.length;
    return response;
  }
}

/**
 * Create a new source to read from a remote file using the fetch API.
 * @param {string} url The URL to send requests to.
 * @param {object} headers Additional headers to be sent to the server.
 */
export function makeFetchSource(url, { headers = {}, blockSize } = {}) {
  return new BlockedSource(async (offset, length) => {
    const response = await fetch(url, {
      headers: Object.assign({},
        headers, {
          Range: `bytes=${offset}-${offset + length}`,
        },
      ),
    });

    // check the response was okay and if the server actually understands range requests
    if (!response.ok) {
      throw new Error('Error fetching data.');
    } else if (response.status === 206) {
      const data = response.arrayBuffer ?
        await response.arrayBuffer() : (await response.buffer()).buffer;
      return {
        data,
        offset,
        length,
      };
    } else {
      const data = response.arrayBuffer ?
        await response.arrayBuffer() : (await response.buffer()).buffer;
      return {
        data,
        offset: 0,
        length: data.byteLength,
      };
    }
  }, { blockSize });
}

/**
 * Create a new source to read from a remote file using the XHR API.
 * @param {string} url The URL to send requests to.
 * @param {object} headers Additional headers to be sent to the server.
 */
export function makeXHRSource(url, { headers = {}, blockSize } = {}) {
  return new BlockedSource(async (offset, length) => {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('GET', url);
      request.responseType = 'arraybuffer';

      Object.entries(
        Object.assign({},
          headers, {
            Range: `bytes=${offset}-${offset + length}`,
          },
        ),
      ).forEach(([key, value]) => request.setRequestHeader(key, value));

      request.onload = () => {
        const data = request.response;
        if (request.status === 206) {
          resolve({
            data,
            offset,
            length,
          });
        } else {
          resolve({
            data,
            offset: 0,
            length: data.byteLength,
          });
        }
      };
      request.onerror = reject;
      request.send();
    });
  }, { blockSize });
}

/**
 * Create a new source to read from a remote file.
 * @param {string} url The URL to send requests to.
 * @param {object} headers Additional headers to be sent to the server.
 */
export function makeRemoteSource(url, options) {
  const { forceXHR } = options;
  if (typeof fetch === 'function' && !forceXHR) {
    return makeFetchSource(url, options);
  }
  return makeXHRSource(url, options);
}

export function makeBufferSource(arrayBuffer) {
  return {
    async fetch(offset, length) {
      return arrayBuffer.slice(offset, offset + length);
    },
  };
}

export function makeFileSource(path) {
  const { promisify } = require('util');
  const { open, read } = require('fs');
  const openAsync = promisify(open);
  const readAsync = promisify(read);

  const fileOpen = openAsync(path, 'r');

  return {
    async fetch(offset, length) {
      const fd = await fileOpen;
      const { buffer } = await readAsync(fd, new Uint8Array(length), 0, length, offset);
      return buffer.buffer;
    },
  };
}

export function makeFileReaderSource(file) {
  return {
    async read(offset, length) {
      return new Promise((resolve, reject) => {
        const blob = file.slice(offset, offset + length);
        const reader = new FileReader();
        reader.onload = event => resolve(event.target.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
    },
  };
}
