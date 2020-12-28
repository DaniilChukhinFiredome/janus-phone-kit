import {BasePlugin} from "./BasePlugin";
import {onceInTimeoutClosure, randomString, retryPromise} from "../util/util";
import {logger} from "../util/logger";
import {Member} from "../Member";
import DeviceManager from "../util/DeviceManager";
import {v4 as uuidv4} from 'uuid';
import {VolumeMeter} from "../util/SoundMeter";
import {StunServer} from "../types";

export class VideoRoomPlugin extends BasePlugin {
  name = 'janus.plugin.videoroomjs'
  memberList: any = {}
  room_id = 1234
  stunServers: StunServer[]
  iceCandidates: any[] = []
  publishers = null
  displayName: string = ''
  rtcConnection: any = null;

  stream: MediaStream;
  offerOptions: any = {}
  isVideoOn: boolean = true
  isAudioOn: boolean = true
  isNoiseFilterOn: boolean = false
  isTalking: boolean = false
  mediaConstraints: any = {}
  bitrate: number = 0
  sessionInfo: any = {}
  private onSlowlink = onceInTimeoutClosure(this.reduceBitrate.bind(this), 15000, 2);
  private volumeMeter: VolumeMeter;

  constructor(options: any = {}) {
    super()
    this.opaqueId = `videoroomtest-${randomString(12)}`;
    this.displayName = options.displayName
    this.room_id = options.roomId
    this.stunServers = options.stunServers
    this.mediaConstraints = options.mediaConstraints;
    this.isAudioOn = !!this.mediaConstraints.audio;
    this.isVideoOn = !!this.mediaConstraints.video;
    this.bitrate = this.mediaConstraints.bitrate;
    this.sessionInfo = options.sessionInfo;
    this.stream = options.stream;
    this.rtcConnection = new RTCPeerConnection({
      iceServers: this.stunServers,
    })
    logger.debug('Init plugin', this);
    // Send ICE events to Janus.
    this.rtcConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return
      }
      this.sendTrickle(event.candidate)
        .catch((err) => {
          logger.warn(err)
        });
    };
    this.rtcConnection.onconnectionstatechange = () => {
      if (this.rtcConnection.iceConnectionState === 'connected') {
        this.setBitrate(this.bitrate);
        this.sendStateMessage({
          audio: this.isAudioOn,
          video: this.isVideoOn,
        });
      }
      if (this.rtcConnection.iceConnectionState === 'disconnected') {
        this.session.emit('disconnected')
        this.session.off()
      }
    };
  }

  /**
   * Start or stop echoing video.
   * @public
   * @param {Boolean} enabled
   * @return {Object} The response from Janus
   */
  async enableVideo(enabled) {
    return this.sendMessage({video: enabled});
  }

  /**
   * Start or stop echoing audio.
   *
   * @public
   * @param {Boolean} enabled
   * @return {Object} The response from Janus
   */
  async enableAudio(enabled) {
    return this.sendMessage({audio: enabled});
  }

  /**
   * Send a REMB packet to the browser to set the media submission bandwidth.
   *
   * @public
   * @param {Number} bitrate - Bits per second
   * @param {Boolean} force - either bitrate must be forced. If not forced janus may deny message if bitrate was changed recently
   * and changes did not take effect yet (used in automatical bitrate reduce)
   * @return {Object} The response from Janus
   */
  async setBitrate(bitrate, force = true) {
    this.bitrate = bitrate;
    await this.sendMessage({bitrate, force});
  }

  /**
   * Receive an asynchronous ('pushed') message sent by the Janus core.
   *
   * @public
   * @override
   */
  async receive(msg) {

    const pluginData = msg?.plugindata?.data

    if (pluginData?.error_code) {
      return
    }

    if (msg.janus === 'trickle') {
      await this.onTrickle(msg)
    }

    if(msg.janus === 'webrtcup') {
      this.session.emit('webrtcup', { ptype: msg.sender === this.id ? 'publisher' : 'subscriber' });
    }

    if (pluginData?.event === 'PublisherStateUpdate') {
      this.onPublisherStateUpdate(msg)
      return
    }

    if (pluginData?.videoroom === 'attached') {
      this.onVideoRoomAttached(msg)
      return
    }

    if (pluginData?.unpublished) {
      this.onHangup(pluginData.unpublished)
      return
    }

    if (pluginData?.publishers) {
      this.onReceivePublishers(msg)
    }

    if (pluginData?.videoroom === 'joined') {
      this.onPublisherInitialStateUpdate(msg)
    }

    if (msg.janus === 'slowlink') {
      if (msg.uplink) {
        const slowMember = Object.values(this.memberList).find((member: Member) => member.handleId === msg.sender)
        if (slowMember) {
          await (slowMember as Member).onSlowlink();
        }
      } else {
        await this.onSlowlink();
      }
      this.session.emit('slowlink', msg);
    }
  }

  private onHangup(unpublished) {
    const hangupMember = this.memberList[unpublished];

    if (!hangupMember) {
      return
    }
    hangupMember.hangup();
    delete this.memberList[unpublished];
  }

  private async onTrickle(message) {
    const candidate = message?.candidate?.completed ? null : message?.candidate
    if (this.rtcConnection.remoteDescription) {
      await this.rtcConnection.addIceCandidate(candidate)
      return
    }
    this.iceCandidates.push(candidate)
  }

  private async processIceCandidates() {
    for(let i = 0; i < this.iceCandidates.length; i++) {
      await this.rtcConnection.addIceCandidate(this.iceCandidates[i])
    }
    this.iceCandidates = []
  }

  private onVideoRoomAttached(message) {
    if (this.memberList[message?.plugindata?.data?.id]) {
      this.memberList[message?.plugindata?.data?.id].answerAttachedStream(message);
    }
  }

  private onPublisherStateUpdate(message) {
    if (this.memberList[message?.plugindata?.data?.newStatePublisher]) {
      this.memberList[message?.plugindata?.data?.newStatePublisher].updateMemberStateFromMessage(message);
    }
  }

  private onPublisherInitialStateUpdate(message) {
    const publishers = message?.plugindata?.data?.publishers
    publishers.forEach(publisher => {
      if (this.memberList[publisher?.id]) {
        this.memberList[publisher?.id].updateMemberState(publisher?.state);
      }
    })
  }

  private onReceivePublishers(msg) {
    const unprocessedMembers = { ...this.memberList };
    msg?.plugindata?.data?.publishers.forEach((publisher) => {

      delete unprocessedMembers[publisher.id];
      if (!this.memberList[publisher.id] && !this.myFeedList.includes(publisher.id)) {
        this.memberList[publisher.id] = new Member(publisher, this);
        this.memberList[publisher.id].attachMember();
      }
    });

    if (msg?.plugindata?.data?.videoroom === 'synced') {
      Object.keys(unprocessedMembers).forEach(key => {
        unprocessedMembers[key].hangup();
        delete this.memberList[key];
      });
    }
    this.publishers = msg?.plugindata?.data?.publishers;
    this.private_id = msg?.plugindata?.data?.private_id;
  }

  async loadStream() {
    const options = {...this.mediaConstraints};
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(options);
      logger.info('Got local user media.');

    } catch (e) {
      if (options.video) {
        this.session.emit('media-error', {
          type: 'CAPTURE_VIDEO_ERROR',
          error: e,
        });
      }
      try {
        options.video = false
        this.stream = await navigator.mediaDevices.getUserMedia(options);
      } catch (ex) {
        options.audio = false
        options.video = this.mediaConstraints.video
        this.stream = await navigator.mediaDevices.getUserMedia(options);
      }
    }
    this.trackMicrophoneVolume();
    return {
      stream: this.stream,
      options
    }
  }

  async requestAudioAndVideoPermissions() {
    logger.info('Asking user to share media. Please wait...');
    return  await this.loadStream();
  }

  /**
   * Set up a bi-directional WebRTC connection:
   *
   * 1. get local media
   * 2. create and send a SDP offer
   * 3. receive a SDP answer and add it to the RTCPeerConnection
   * 4. negotiate ICE (can happen concurrently with the SDP exchange)
   * 5. Play the video via the `onaddstream` event of RTCPeerConnection
   *
   * @private
   * @override
   */
  async onAttached() {
      const joinResult = await this.sendMessage({
        request: 'join',
        room: this.room_id,
        ptype: 'publisher',
        display: this.displayName,
        opaque_id: this.opaqueId,
        customInfo: this.sessionInfo,
      })

    if (!joinResult || !joinResult.janus) {
      this.session.offAll();
      await this.hangup();
      return;
    }

    if (!this.stream) {
      await this.requestAudioAndVideoPermissions();
      DeviceManager.toggleAudioMute(this.stream, this.isAudioOn)
      DeviceManager.toggleAudioMute(this.stream, this.isVideoOn)
    } else {
      this.trackMicrophoneVolume();
    }

    this.session.emit('member:join', {
      stream: this.stream,
      joinResult,
      sender: 'me',
      type: 'publisher',
      name: this.displayName,
      state: {
        audio: !!this.stream.getAudioTracks().length,
        video: !!this.stream.getVideoTracks().length,
      },
      id: uuidv4(),
      info: this.sessionInfo,
    })

    logger.info('Adding local user media to RTCPeerConnection.');
    // pass through audio context
    this.addTracks(this.stream.getVideoTracks());
    this.addTracks(this.volumeMeter.getBypassedAudio().getTracks());

    this.rtcConnection.onnegotiationneeded = async () => {
      const audio = !!this.stream.getAudioTracks().length;
      const video = !!this.stream.getVideoTracks().length;
      await this.sendConfigureMessage({
        audio,
        video,
      })
      await this.sendInitialState()
    }
  }

  trackMicrophoneVolume() {
    const volumeMeter = new VolumeMeter(this.stream)
    volumeMeter.onAudioProcess(async (newValue, oldValue) => {
      const setTalking = isTalking => {
        this.session.emit('member:update', {
          sender: 'me',
          type: 'publisher',
          state: {isTalking},
          info: this.sessionInfo,
        });
      }
      if (newValue >= 20 && oldValue < 20) {
        if (this.isAudioOn) {
          setTalking(true);
          await this.sendStateMessage({isTalking: true});
        } else {
          this.session.emit('is-talking-muted')
        }
      } else if (newValue <= 20 && oldValue > 20) {
        if (this.isAudioOn) {
          setTalking(false);
          await this.sendStateMessage({isTalking: false});
        }
      }
    });
    this.volumeMeter = volumeMeter;
  }

  async startVideo() {
    if (this.stream.getVideoTracks().length > 0) {
      this.stream && DeviceManager.toggleVideoMute(this.stream, true)
      await this.enableVideo(true)
      this.isVideoOn = true
      await this.sendStateMessage({
        video: true
      })
    }
  }

  async stopVideo() {
    this.stream && DeviceManager.toggleVideoMute(this.stream, false)
    await this.enableVideo(false)
    this.isVideoOn = false
    await this.sendStateMessage({
      video: false
    })
  }

  async startAudio() {
    if(this.stream) {
      DeviceManager.toggleAudioMute(this.stream, true)
      DeviceManager.toggleAudioMute(this.volumeMeter.getBypassedAudio(), true)
    }
    await this.enableAudio(true)
    this.isAudioOn = true
    await this.sendStateMessage({
      audio: true
    })
  }

  async stopAudio() {
    this.stream && DeviceManager.toggleAudioMute(this.volumeMeter.getBypassedAudio(), false)
    await this.enableAudio(false)
    this.isAudioOn = false
    await this.sendStateMessage({
      audio: false
    })
  }

  startNoiseFilter() {
    this.isNoiseFilterOn = true;
    if (!this.isTalking) {
      // implementation not ready
    }
  }

  stopNoiseFilter() {
    this.isNoiseFilterOn = false;
    // implementation not ready
  }

  async changePublisherStream(newConstraints) {
    this.adjustMediaConstraints(newConstraints);
    const {stream} = await this.loadStream();
    this.session.emit('member:update', {
      sender: 'me',
      type: 'publisher',
      info: this.sessionInfo,
      stream,
    });
    this.volumeMeter.getBypassedAudio().getAudioTracks().forEach(track => {
      const audioSender = this.rtcConnection.getSenders().find(sender => sender.track.kind === track.kind);
      audioSender.replaceTrack(track);
      if (!this.isAudioOn) {
        track.enabled = false
      }
    });
    stream.getVideoTracks().forEach(track => {
      const videoSender = this.rtcConnection.getSenders().find(sender => sender.track.kind === track.kind);
      if (videoSender) {
        videoSender.replaceTrack(track);
      } else {
        this.rtcConnection.addTrack(track);
      }
      if (!this.isVideoOn) {
        track.enabled = false
      }
    });
    return stream;
  }

  adjustMediaConstraints({audio, video}) {
    const adjustConstraint = (type, constraint) => {
      if (typeof this.mediaConstraints[type] === 'object') {
        if (typeof audio === 'object') {
          this.mediaConstraints[type] = {
            ...this.mediaConstraints[type], ...constraint,
          };
        } else {
          this.mediaConstraints[type] = constraint;
        }
      }
      if (typeof this.mediaConstraints[type] !== 'object') {
        this.mediaConstraints[type] = constraint;
      }
    }
    adjustConstraint('audio', audio);
    adjustConstraint('video', video);
  }

  async sendConfigureMessage(options) {
    const jsepOffer = await this.rtcConnection.createOffer(this.offerOptions);
    await this.rtcConnection.setLocalDescription(jsepOffer);

    let confResult
    try {
      const configurePromiseCreator = () => this.sendMessage({
        request: 'configure',
        ...options,
      }, jsepOffer);
      confResult = await retryPromise(configurePromiseCreator);
    } catch (e) {
      this.session.emit('disconnected');
      this.session.offAll()
      return
    }

    // @ts-ignore
    await this.rtcConnection.setRemoteDescription(confResult.jsep);
    await this.processIceCandidates()

    return confResult
  }

  public async sendStateMessage(data = {}) {
    await this.sendMessage({
      request: 'state',
      data,
    })
  }

  private async sendInitialState() {
    await this.sendMessage({
      request: 'state',
      data: {
        status: 'online',
        name: this.displayName
      },
    })
  }

  addTracks(tracks: MediaStreamTrack[]) {
    tracks.forEach((track) => {
      this.rtcConnection.addTrack(track);
    });
  }

  async hangup() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        track.stop()
      })
    }
    if (this.rtcConnection) {
      this.rtcConnection.close();
      this.rtcConnection = null;
    }

    await this.send({janus: 'hangup'});
  }

  public async syncParticipants() {
    await this.sendMessage({
      request: 'sync'
    });
  }

  close() {
    if (this.rtcConnection) {
      this.rtcConnection.close();
      this.rtcConnection = null;
    }
    const members = Object.values(this.memberList);
    members.forEach((member: any) => member.hangup());
  }

  private async reduceBitrate() {
    const newBitrate = this.bitrate / 2;
    await this.setBitrate(newBitrate, false);
    logger.info(`Bitrate reduced for uplink to ${newBitrate} Kbit/s`);
  }
}
