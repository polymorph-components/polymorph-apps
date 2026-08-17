"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RTCDtlsParameters = exports.RTCDtlsFingerprint = exports.RTCCertificate = exports.DtlsStates = exports.RTCDtlsTransport = void 0;
const x509_1 = require("@fidm/x509");
const promises_1 = require("timers/promises");
const uuid_1 = require("uuid");
const common_1 = require("../imports/common");
const dtls_1 = require("../imports/dtls");
const rtp_1 = require("../imports/rtp");
const stats_1 = require("../media/stats");
const utils_1 = require("../utils");
const log = (0, rtp_1.debug)("werift:packages/webrtc/src/transport/dtls.ts");
class RTCDtlsTransport {
    constructor(config, iceTransport, localCertificate, srtpProfiles = []) {
        Object.defineProperty(this, "config", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: config
        });
        Object.defineProperty(this, "iceTransport", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: iceTransport
        });
        Object.defineProperty(this, "localCertificate", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: localCertificate
        });
        Object.defineProperty(this, "srtpProfiles", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: srtpProfiles
        });
        Object.defineProperty(this, "id", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (0, uuid_1.v4)()
        });
        Object.defineProperty(this, "state", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "new"
        });
        Object.defineProperty(this, "role", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "auto"
        });
        Object.defineProperty(this, "srtpStarted", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "transportSequenceNumber", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        // Statistics tracking
        Object.defineProperty(this, "bytesSent", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "bytesReceived", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "packetsSent", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "packetsReceived", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "dataReceiver", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "dtls", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "srtp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "srtcp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "onStateChange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new common_1.Event()
        });
        Object.defineProperty(this, "onRtcp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new common_1.Event()
        });
        Object.defineProperty(this, "onRtp", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new common_1.Event()
        });
        Object.defineProperty(this, "remoteParameters", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "sendData", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: async (data) => {
                if (this.config.debug.outboundPacketLoss &&
                    this.config.debug.outboundPacketLoss / 100 < Math.random()) {
                    return;
                }
                if (!this.dtls) {
                    throw new Error("dtls not established");
                }
                await this.dtls.send(data);
            }
        });
        this.localCertificate ?? (this.localCertificate = RTCDtlsTransport.localCertificate);
    }
    get localParameters() {
        return new RTCDtlsParameters(this.localCertificate ? this.localCertificate.getFingerprints() : [], this.role);
    }
    static async SetupCertificate() {
        if (this.localCertificate) {
            return this.localCertificate;
        }
        if (this.localCertificatePromise) {
            return this.localCertificatePromise;
        }
        this.localCertificatePromise = (async () => {
            const { certPem, keyPem, signatureHash } = await dtls_1.CipherContext.createSelfSignedCertificateWithKey({
                signature: dtls_1.SignatureAlgorithm.ecdsa_3,
                hash: dtls_1.HashAlgorithm.sha256_4,
            }, dtls_1.NamedCurveAlgorithm.secp256r1_23);
            this.localCertificate = new RTCCertificate(keyPem, certPem, signatureHash);
            return this.localCertificate;
        })();
        return this.localCertificatePromise;
    }
    setRemoteParams(remoteParameters) {
        this.remoteParameters = remoteParameters;
    }
    async start() {
        if (this.state !== "new") {
            throw new Error("state must be new");
        }
        if (this.remoteParameters?.fingerprints.length === 0) {
            throw new Error("remote fingerprint not exist");
        }
        if (this.role === "auto") {
            if (this.iceTransport.role === "controlling") {
                this.role = "server";
            }
            else {
                this.role = "client";
            }
        }
        this.setState("connecting");
        await new Promise(async (r, f) => {
            if (this.role === "server") {
                this.dtls = new dtls_1.DtlsServer({
                    cert: this.localCertificate?.certPem,
                    key: this.localCertificate?.privateKey,
                    signatureHash: this.localCertificate?.signatureHash,
                    transport: createIceTransport(this.iceTransport.connection),
                    srtpProfiles: this.srtpProfiles,
                    extendedMasterSecret: true,
                    // certificateRequest: true,
                });
            }
            else {
                this.dtls = new dtls_1.DtlsClient({
                    cert: this.localCertificate?.certPem,
                    key: this.localCertificate?.privateKey,
                    signatureHash: this.localCertificate?.signatureHash,
                    transport: createIceTransport(this.iceTransport.connection),
                    srtpProfiles: this.srtpProfiles,
                    extendedMasterSecret: true,
                });
            }
            this.dtls.onData.subscribe((buf) => {
                if (this.config.debug.inboundPacketLoss &&
                    this.config.debug.inboundPacketLoss / 100 < Math.random()) {
                    return;
                }
                this.dataReceiver(buf);
            });
            this.dtls.onClose.subscribe(() => {
                this.setState("closed");
            });
            this.dtls.onConnect.once(r);
            this.dtls.onError.once((error) => {
                this.setState("failed");
                log("dtls failed", error);
                f(error);
            });
            if (this.dtls instanceof dtls_1.DtlsClient) {
                await (0, promises_1.setTimeout)(100);
                this.dtls.connect().catch((error) => {
                    this.setState("failed");
                    log("dtls connect failed", error);
                    f(error);
                });
            }
        });
        if (this.srtpProfiles.length > 0) {
            this.startSrtp();
        }
        this.dtls.onConnect.subscribe(() => {
            this.updateSrtpSession();
            this.setState("connected");
        });
        this.setState("connected");
        log("dtls connected");
    }
    updateSrtpSession() {
        if (!this.dtls)
            throw new Error();
        const profile = this.dtls.srtp.srtpProfile;
        if (!profile) {
            throw new Error("need srtpProfile");
        }
        log("selected SRTP Profile", profile);
        const { localKey, localSalt, remoteKey, remoteSalt } = this.dtls.extractSessionKeys((0, rtp_1.keyLength)(profile), (0, rtp_1.saltLength)(profile));
        const config = {
            keys: {
                localMasterKey: localKey,
                localMasterSalt: localSalt,
                remoteMasterKey: remoteKey,
                remoteMasterSalt: remoteSalt,
            },
            profile,
        };
        this.srtp = new rtp_1.SrtpSession(config);
        this.srtcp = new rtp_1.SrtcpSession(config);
    }
    startSrtp() {
        if (this.srtpStarted)
            return;
        this.srtpStarted = true;
        this.updateSrtpSession();
        this.iceTransport.connection.onData.subscribe((data) => {
            if (this.config.debug.inboundPacketLoss &&
                this.config.debug.inboundPacketLoss / 100 < Math.random()) {
                return;
            }
            if (!(0, rtp_1.isMedia)(data))
                return;
            // Track received data statistics
            this.bytesReceived += data.length;
            this.packetsReceived++;
            if ((0, rtp_1.isRtcp)(data)) {
                const dec = this.srtcp.decrypt(data);
                const rtcpPackets = rtp_1.RtcpPacketConverter.deSerialize(dec);
                for (const rtcp of rtcpPackets) {
                    try {
                        this.onRtcp.execute(rtcp);
                    }
                    catch (error) {
                        log("RTCP error", error);
                    }
                }
            }
            else {
                const dec = this.srtp.decrypt(data);
                const rtp = rtp_1.RtpPacket.deSerialize(dec);
                try {
                    this.onRtp.execute(rtp);
                }
                catch (error) {
                    log("RTP error", error);
                }
            }
        });
    }
    async sendRtp(payload, header) {
        try {
            const enc = this.srtp.encrypt(payload, header);
            if (this.config.debug.outboundPacketLoss &&
                this.config.debug.outboundPacketLoss / 100 < Math.random()) {
                return enc.length;
            }
            // Track statistics
            this.bytesSent += enc.length;
            this.packetsSent++;
            await this.iceTransport.connection.send(enc).catch(() => { });
            return enc.length;
        }
        catch (error) {
            log("failed to send", error);
            return 0;
        }
    }
    async sendRtcp(packets) {
        const payload = Buffer.concat(packets.map((packet) => packet.serialize()));
        const enc = this.srtcp.encrypt(payload);
        if (this.config.debug.outboundPacketLoss &&
            this.config.debug.outboundPacketLoss / 100 < Math.random()) {
            return enc.length;
        }
        // Track statistics
        this.bytesSent += enc.length;
        this.packetsSent++;
        await this.iceTransport.connection.send(enc).catch(() => { });
    }
    setState(state) {
        if (state != this.state) {
            this.state = state;
            this.onStateChange.execute(state);
        }
    }
    async stop() {
        this.setState("closed");
        // todo impl send alert
        await this.iceTransport.stop();
    }
    async getStats() {
        const timestamp = (0, stats_1.getStatsTimestamp)();
        const stats = [];
        const transportId = (0, stats_1.generateStatsId)("transport", this.id);
        // Transport stats
        const transportStats = {
            type: "transport",
            id: transportId,
            timestamp,
            bytesSent: this.bytesSent,
            bytesReceived: this.bytesReceived,
            packetsSent: this.packetsSent,
            packetsReceived: this.packetsReceived,
            dtlsState: this.state,
            iceState: this.iceTransport.state,
            selectedCandidatePairId: this.iceTransport.connection.nominated
                ? (0, stats_1.generateStatsId)("candidate-pair", this.iceTransport.connection.nominated.localCandidate.foundation, this.iceTransport.connection.nominated.remoteCandidate.foundation)
                : undefined,
            localCertificateId: this.localCertificate
                ? (0, stats_1.generateStatsId)("certificate", "local")
                : undefined,
            remoteCertificateId: this.remoteParameters
                ? (0, stats_1.generateStatsId)("certificate", "remote")
                : undefined,
            dtlsRole: this.role === "auto" ? undefined : this.role,
        };
        stats.push(transportStats);
        // Certificate stats
        if (this.localCertificate) {
            const fingerprints = this.localCertificate.getFingerprints();
            if (fingerprints.length > 0) {
                const certStats = {
                    type: "certificate",
                    id: (0, stats_1.generateStatsId)("certificate", "local"),
                    timestamp,
                    fingerprint: fingerprints[0].value,
                    fingerprintAlgorithm: fingerprints[0].algorithm,
                    base64Certificate: Buffer.from(this.localCertificate.certPem).toString("base64"),
                };
                stats.push(certStats);
            }
        }
        if (this.remoteParameters &&
            this.remoteParameters.fingerprints.length > 0) {
            const certStats = {
                type: "certificate",
                id: (0, stats_1.generateStatsId)("certificate", "remote"),
                timestamp,
                fingerprint: this.remoteParameters.fingerprints[0].value,
                fingerprintAlgorithm: this.remoteParameters.fingerprints[0].algorithm,
                base64Certificate: "", // Remote certificate content not available
            };
            stats.push(certStats);
        }
        // Get ICE stats
        const iceStats = await this.iceTransport.getStats();
        stats.push(...iceStats);
        return stats;
    }
}
exports.RTCDtlsTransport = RTCDtlsTransport;
exports.DtlsStates = [
    "new",
    "connecting",
    "connected",
    "closed",
    "failed",
];
class RTCCertificate {
    constructor(privateKeyPem, certPem, signatureHash) {
        Object.defineProperty(this, "certPem", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: certPem
        });
        Object.defineProperty(this, "signatureHash", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: signatureHash
        });
        Object.defineProperty(this, "publicKey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "privateKey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        const cert = x509_1.Certificate.fromPEM(Buffer.from(certPem));
        this.publicKey = cert.publicKey.toPEM();
        this.privateKey = x509_1.PrivateKey.fromPEM(Buffer.from(privateKeyPem)).toPEM();
    }
    getFingerprints() {
        return [
            new RTCDtlsFingerprint("sha-256", (0, utils_1.fingerprint)(x509_1.Certificate.fromPEM(Buffer.from(this.certPem)).raw, "sha256")),
        ];
    }
}
exports.RTCCertificate = RTCCertificate;
class RTCDtlsFingerprint {
    constructor(algorithm, value) {
        Object.defineProperty(this, "algorithm", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: algorithm
        });
        Object.defineProperty(this, "value", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: value
        });
    }
}
exports.RTCDtlsFingerprint = RTCDtlsFingerprint;
class RTCDtlsParameters {
    constructor(fingerprints = [], role) {
        Object.defineProperty(this, "fingerprints", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: fingerprints
        });
        Object.defineProperty(this, "role", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: role
        });
    }
}
exports.RTCDtlsParameters = RTCDtlsParameters;
class IceTransport {
    constructor(ice) {
        Object.defineProperty(this, "ice", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ice
        });
        Object.defineProperty(this, "onData", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        Object.defineProperty(this, "type", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: "ice"
        });
        Object.defineProperty(this, "send", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (data) => {
                return this.ice.send(data);
            }
        });
        ice.onData.subscribe((buf) => {
            if ((0, utils_1.isDtls)(buf)) {
                if (this.onData) {
                    this.onData(buf);
                }
            }
        });
    }
    get address() {
        return {};
    }
    async close() {
        this.ice.close();
    }
}
const createIceTransport = (ice) => new IceTransport(ice);
//# sourceMappingURL=dtls.js.map