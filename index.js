const EventEmitter = require('events')
const {SerialPort} = require('serialport')
const crc8 = require('./crc8')
const cbor = require('cbor-sync')
var URL = require('url').URL

function tonumberifpossible(val) {
  const num = Number(val)
  if (isNaN(num)) return val
  return num
}
const ports = new Map()

class ITMPSerialPort extends EventEmitter {
  constructor(url, props) {
    super()
    this.name = url
    const portprops = Object.assign({}, props)
    const parsedurl = new URL(url)
    parsedurl.searchParams.forEach((value, name) => {
      portprops[name] = tonumberifpossible(value)
    })
    const portname = parsedurl.host + parsedurl.pathname
    portprops['path'] = portname
    this.port = new SerialPort( portprops)

    // incoming messages encoding
    this.inbuf = Buffer.allocUnsafe(1024) // buffer for incoming bytes
    this.inpos = 0 // number of received bytes (inbuf position)
    this.lastchar = 0 // code of last received char =0 means no special character
    this.incrc = 0xff // current crc calculation

    this.busy = false // bus busy flag
    this.timerId = null // timeout timer id
    this.closing = false
    
    this.bustimeout = portprops['bustimeout'] ? portprops['bustimeout'] : 50
    this.emitraw = portprops['raw'] ? portprops['raw'] : false

    this.cur_addr = 0 // current transaction address
    this.cur_buf = Buffer.allocUnsafe(1024)
    this.msgqueue = []
    this.autoReconnect = true

    this.links = new Map() // address to link map

    // Open errors will be emitted as an error event
    this.port.on('error', (err) => {
      //console.log('Error: ', err.message)
      if (!this.closing)
      setTimeout((that) => {
        if (!that.port.isOpen) {
          that.port.open()
        }
      }, 3000, this)
    })

    this.port.on('data', (data) => {
      try {
        this.income(data);
      } catch (e) {
        console.error(e);
      }
    })
    this.port.on('open', () => {
      this.ready = true
      this.links.forEach((lnk)=>lnk.onconnect())
    })
    this.port.on('close', () => {
      this.ready = false
      this.links.forEach((lnk)=>lnk.ondisconnect())
      while (this.msgqueue.length > 0) {
        const [addr, msg, resolve, reject] = this.msgqueue.shift()
        reject()
      }
      if (this.autoReconnect)
        setTimeout((that) => that.port.open(), 100, this)
    })
  }

  stop() {
    this.autoReconnect = false
    this.port.close()
    clearTimeout(this.timerId)
  }

  close() {
    this.closing = true
    this.autoReconnect = false
    this.port.close()
    clearTimeout(this.timerId)
  }

  addlink(subaddr, link) {
    this.links.set(+subaddr, link)
  }
  removelink(subaddr) {
    return this.links.delete(+subaddr)
  }
  getlink(subaddr) {
    return this.links.get(+subaddr)
  }
  income(data) {
    for (let i = 0; i < data.length; i++) {
      if (this.lastchar === 0x7d) {
        this.inbuf[this.inpos] = data[i] ^ 0x20
        this.incrc = crc8.docrc8(this.incrc, this.inbuf[this.inpos])
        this.inpos++
        this.lastchar = 0
      } else if (data[i] === 0x7d) {
        this.lastchar = 0x7d
      } else if (data[i] === 0x7e) {
        if (this.inpos > 2 && this.incrc === 0 /* this.inbuf[this.inpos-1] */) {
          const addr = this.inbuf[0]
          const link = this.links.get(addr)
          try {
            const msg = cbor.decode(this.inbuf.subarray(1, this.inpos - 1))
            if (this.emitraw)
              this.links.forEach((lnk)=>lnk.rawmessage(msg,addr))
            if (link) {
              link.process(msg)
            }
          } catch (err){
            // console.error(err)
          } finally {
            this.nexttransaction()
          }
        }
        this.lastchar = 0
        this.inpos = 0
        this.incrc = 0xff
      } else {
        this.inbuf[this.inpos] = data[i]
        this.incrc = crc8.docrc8(this.incrc, this.inbuf[this.inpos])
        this.inpos += 1
      }
    }
  }

  nexttransaction() {
    if (this.msgqueue.length > 0) {
      const [addr, msg, resolve, reject] = this.msgqueue.shift()
      this.cur_addr = addr
      clearTimeout(this.timerId)
      this.timerId = setTimeout(() => {
        this.timeisout()
      }, this.bustimeout)
      this.internalsend(addr, msg)
      resolve()
    } else {
      this.cur_addr = 0
      if (this.busy) {
        this.busy = false
        clearTimeout(this.timerId)
      } else {
        //console.log('message written')
      }
    }
  }

  timeisout() {
    if (typeof this.cur_err === 'function') {
      this.cur_err('timeout')
    }
    this.nexttransaction()
  }

  send(addr, msg) {
    const binmsg = cbor.encode(msg)

    return new Promise((resolve, reject) => {
      if (this.busy) {
        this.msgqueue.push([addr, binmsg, resolve, reject])
      } else {
        this.busy = true
        this.cur_addr = addr
        this.timerId = setTimeout(() => {
          this.timeisout()
        }, this.bustimeout)
        this.internalsend(addr, binmsg)
        resolve()
      }
    })
  }

  internalsend(addr, binmsg) {
    if (this.cur_buf.length < binmsg.length * 2) {
      this.cur_buf = Buffer.allocUnsafe(binmsg.length * 2)
    }

    let crc = 0xff
    this.cur_buf[0] = 0x7e
    this.cur_buf[1] = addr // address
    crc = crc8.docrc8(crc, this.cur_buf[1])

    let pos = 2
    for (let i = 0; i < binmsg.length; i++) {
      crc = crc8.docrc8(crc, binmsg[i])
      if (binmsg[i] === 0x7e || binmsg[i] === 0x7d) {
        this.cur_buf[pos] = 0x7d
        this.cur_buf[pos + 1] = binmsg[i] ^ 0x20
        pos += 2
      } else {
        this.cur_buf[pos] = binmsg[i]
        pos++
      }
    }
    if (crc === 0x7e || crc === 0x7d) {
      this.cur_buf[pos] = 0x7d
      this.cur_buf[pos + 1] = crc ^ 0x20
      pos += 2
    } else {
      this.cur_buf[pos] = crc
      pos++
    }

    this.cur_buf[pos] = 0x7e
    const sndbuf = this.cur_buf.subarray(0, pos + 1)

    this.port.write(sndbuf, (errdt) => {
      if (errdt) {
        //console.log('Error on write: ', errdt.message)
      }
    })
    //    var timerId = setTimeout( (key)=>{ var prom = that.transactions.get(key);
    // that.transactions.delete(key); prom.err("timeout"); }, 2000, key);
  }

  async connect() {
    return new Promise((resolve, reject) => {
      if (this.isconnected()) {
        resolve()
      } else {
        this.once('connect', () => {
          resolve()
        })
      }
    })
  }
}

/*
SerialPort.list((err, ports) => {
  if (err) { return }
  ports.forEach((port) => {
    console.log(port.comName + JSON.stringify(port))
  })
})

{
  this.ports = {}
  SerialPort.list((err, ports) => {
    if (err) {
    } else {
      const ctx = this
      ports.forEach((port) => {
        ctx.ports[port.comName] = port
        // console.log(port.comName+JSON.stringify(port));
        // console.log(port.manufacturer);
      })
    }
  })
}
*/

class ITMPSerialLink extends EventEmitter {
  constructor(addr, cfg) {
    super()
    if (!cfg.role) cfg.role = 'internal'
    let addrarray = addr.split('~')
    let port = ports.get(addrarray[0])
    if (!port) {
      port = new ITMPSerialPort(addrarray[0])
      ports.set(addrarray[0], port)
    }
    this.port = port
    this.subaddr = +addrarray[1]
    this.port.addlink(+addrarray[1], this)
  }
  send(msg) {
    return this.port.send(this.subaddr, msg)
  }
  rawmessage(msg,addr) {
    this.emit('rawmessage', {msg,addr})
  }
  process(msg) {
    this.emit('message', msg)
  }
  connect() {
    this.emit('connect')
  }
  onconnect() {
    this.emit('connect')
  }
  ondisconnect() {
    this.emit('disconnect')
  }
  close(){
    this.port.close()
  }
  setsubaddress(subaddr) {
    if (this.port.getlink(this.subaddr) !== this)
      throw new Error('wrong subaddr')
    if (this.port.getlink(+subaddr) !== undefined)
      throw new Error('Busy subaddr')
    this.port.removelink(this.subaddr)
    this.port.addlink(+subaddr, this)
    this.subaddr = +subaddr
  }

  static addAlias(addr, alias) {
    let addrarray = addr.split('~')
    let port = ports.get(addrarray[0])
    if (!port) {
      port = new ITMPSerialPort(addrarray[0])
      ports.set(addrarray[0], port)
      ports.set(alias, port)
    }
  }
}

module.exports = ITMPSerialLink
