import type { BaseMessage } from '../../../core/types.js';
import type { RecordsWriteAttestationPayload, RecordsWriteAuthorizationPayload, RecordsWriteDescriptor, RecordsWriteMessage, UnsignedRecordsWriteMessage } from '../types.js';

import { Encoder } from '../../../utils/encoder.js';
import { GeneralJwsSigner } from '../../../jose/jws/general/signer.js';
import { getCurrentTimeInHighPrecision } from '../../../utils/time.js';
import { Jws } from '../../../utils/jws.js';
import { Message } from '../../../core/message.js';
import { MessageStore } from '../../../store/message-store.js';
import { ProtocolAuthorization } from '../../../core/protocol-authorization.js';
import { removeUndefinedProperties } from '../../../utils/object.js';

import { authorize, validateAuthorizationIntegrity } from '../../../core/auth.js';
import { Cid, computeCid } from '../../../utils/cid.js';
import { DwnInterfaceName, DwnMethodName } from '../../../core/message.js';
import type { GeneralJws, SignatureInput } from '../../../jose/jws/general/types.js';

export type RecordsWriteOptions = {
  recipient?: string;
  protocol?: string;
  contextId?: string;
  schema?: string;
  recordId?: string;
  parentId?: string;
  data?: Uint8Array;
  dataCid?: string;
  dataSize?: number;
  dateCreated?: string;
  dateModified?: string;
  published?: boolean;
  datePublished?: string;
  dataFormat: string;
  authorizationSignatureInput: SignatureInput;
  attestationSignatureInputs?: SignatureInput[];
};

export type CreateFromOptions = {
  unsignedRecordsWriteMessage: UnsignedRecordsWriteMessage,
  data?: Uint8Array;
  published?: boolean;
  dateModified?: string;
  datePublished?: string;
  authorizationSignatureInput: SignatureInput;
  attestationSignatureInputs?: SignatureInput[];
};

export class RecordsWrite extends Message {
  /**
   * RecordsWrite message adhering to the DWN specification.
   */
  readonly message: RecordsWriteMessage;
  readonly attesters: string[];

  private constructor(message: RecordsWriteMessage) {
    super(message);

    this.attesters = RecordsWrite.getAttesters(message);

    // consider converting isInitialWrite() & getEntryId() into properties for performance and convenience
  }

  public static async parse(message: RecordsWriteMessage): Promise<RecordsWrite> {
    // asynchronous checks that are required by the constructor to initialize members properly
    await validateAuthorizationIntegrity(message, { allowedProperties: new Set(['recordId', 'contextId', 'attestationCid']) });
    await RecordsWrite.validateAttestationIntegrity(message);

    const recordsWrite = new RecordsWrite(message);

    await recordsWrite.validateIntegrity(); // RecordsWrite specific data integrity check

    return recordsWrite;
  }

  /**
   * Creates a RecordsWrite message.
   * @param options.recordId If `undefined`, will be auto-filled as a originating message as convenience for developer.
   * @param options.data Data used to compute the `dataCid`. Must specify `option.dataCid` if `undefined`.
   * @param options.dataCid CID of the data that is already stored in the DWN. Must specify `option.data` if `undefined`.
   * @param options.dataSize Size of data in number of bytes. Must be defined if `option.dataCid` is defined; must be `undefined` otherwise.
   * @param options.dateCreated If `undefined`, it will be auto-filled with current time.
   * @param options.dateModified If `undefined`, it will be auto-filled with current time.
   */
  public static async create(options: RecordsWriteOptions): Promise<RecordsWrite> {
    const currentTime = getCurrentTimeInHighPrecision();

    if ((options.data === undefined && options.dataCid === undefined) ||
        (options.data !== undefined && options.dataCid !== undefined)) {
      throw new Error('one and only one parameter between `data` and `dataCid` is allowed');
    }

    if ((options.dataCid === undefined && options.dataSize !== undefined) ||
        (options.dataCid !== undefined && options.dataSize === undefined)) {
      throw new Error('`dataCid` and `dataSize` must both be defined or undefined at the same time');
    }

    const dataCid = options.dataCid ?? await Cid.computeDagPbCidFromBytes(options.data!);
    const dataSize = options.dataSize ?? options.data!.length;

    const descriptor: RecordsWriteDescriptor = {
      interface     : DwnInterfaceName.Records,
      method        : DwnMethodName.Write,
      protocol      : options.protocol,
      recipient     : options.recipient,
      schema        : options.schema,
      parentId      : options.parentId,
      dataCid,
      dataSize,
      dateCreated   : options.dateCreated ?? currentTime,
      dateModified  : options.dateModified ?? currentTime,
      published     : options.published,
      datePublished : options.datePublished,
      dataFormat    : options.dataFormat
    };

    // generate `datePublished` if the message is to be published but `datePublished` is not given
    if (options.published === true &&
      options.datePublished === undefined) {
      descriptor.datePublished = currentTime;
    }

    // delete all descriptor properties that are `undefined` else the code will encounter the following IPLD issue when attempting to generate CID:
    // Error: `undefined` is not supported by the IPLD Data Model and cannot be encoded
    removeUndefinedProperties(descriptor);

    const author = Jws.extractDid(options.authorizationSignatureInput.protectedHeader.kid);

    // `recordId` computation
    const recordId = options.recordId ?? await RecordsWrite.getEntryId(author, descriptor);

    // `contextId` computation
    let contextId: string | undefined;
    if (options.contextId !== undefined) {
      contextId = options.contextId;
    } else { // `contextId` is undefined
      // we compute the contextId for the caller if `protocol` is specified (this is the case of the root message of a protocol context)
      if (descriptor.protocol !== undefined) {
        contextId = await RecordsWrite.getEntryId(author, descriptor);
      }
    }

    // `attestation` generation
    const descriptorCid = await computeCid(descriptor);
    const attestation = await RecordsWrite.createAttestation(descriptorCid, options.attestationSignatureInputs);

    // `authorization` generation
    const authorization = await RecordsWrite.createAuthorization(
      recordId,
      contextId,
      descriptorCid,
      attestation,
      options.authorizationSignatureInput
    );

    const message: RecordsWriteMessage = {
      recordId,
      descriptor,
      authorization
    };

    if (contextId !== undefined) { message.contextId = contextId; } // assign `contextId` only if it is defined
    if (attestation !== undefined) { message.attestation = attestation; } // assign `attestation` only if it is defined

    Message.validateJsonSchema(message);

    return new RecordsWrite(message);
  }

  /**
   * Convenience method that creates a message by:
   * 1. Copying over immutable properties from the given unsigned message
   * 2. Copying over mutable properties that are not overwritten from the given unsigned message
   * 3. Replace the mutable properties that are given new value
   * @param options.unsignedRecordsWriteMessage Unsigned message that the new RecordsWrite will be based from.
   * @param options.dateModified The new date the record is modified. If not given, current time will be used .
   * @param options.data The new data or the record. If not given, data from given message will be used.
   * @param options.published The new published state. If not given, then will be set to `true` if {options.dateModified} is given;
   * else the state from given message will be used.
   * @param options.publishedDate The new date the record is modified. If not given, then:
   * - will not be set if the record will be unpublished as the result of this RecordsWrite; else
   * - will be set to the same published date as the given message if it wss already published; else
   * - will be set to current time (because this is a toggle from unpublished to published)
   */
  public static async createFrom(options: CreateFromOptions): Promise<RecordsWrite> {
    const unsignedMessage = options.unsignedRecordsWriteMessage;
    const currentTime = getCurrentTimeInHighPrecision();

    // inherit published value from parent if neither published nor datePublished is specified
    const published = options.published ?? (options.datePublished ? true : unsignedMessage.descriptor.published);
    // use current time if published but no explicit time given
    let datePublished: string | undefined = undefined;
    // if given explicitly published dated
    if (options.datePublished) {
      datePublished = options.datePublished;
    } else {
      // if this RecordsWrite will publish the record
      if (published) {
        // the parent was already published, inherit the same published date
        if (unsignedMessage.descriptor.published) {
          datePublished = unsignedMessage.descriptor.datePublished;
        } else {
          // this is a toggle from unpublished to published, use current time
          datePublished = currentTime;
        }
      }
    }

    const createOptions: RecordsWriteOptions = {
      // immutable properties below, just inherit from the message given
      recipient                   : unsignedMessage.descriptor.recipient,
      recordId                    : unsignedMessage.recordId,
      dateCreated                 : unsignedMessage.descriptor.dateCreated,
      contextId                   : unsignedMessage.contextId,
      protocol                    : unsignedMessage.descriptor.protocol,
      parentId                    : unsignedMessage.descriptor.parentId,
      schema                      : unsignedMessage.descriptor.schema,
      dataFormat                  : unsignedMessage.descriptor.dataFormat,
      // mutable properties below
      dateModified                : options.dateModified ?? currentTime,
      published,
      datePublished,
      data                        : options.data,
      dataCid                     : options.data ? undefined : unsignedMessage.descriptor.dataCid, // if data not given, use base message dataCid
      dataSize                    : options.data ? undefined : unsignedMessage.descriptor.dataSize, // if data not given, use base message dataSize
      // finally still need input for signing
      authorizationSignatureInput : options.authorizationSignatureInput,
      attestationSignatureInputs  : options.attestationSignatureInputs
    };

    const recordsWrite = await RecordsWrite.create(createOptions);
    return recordsWrite;
  }

  public async authorize(tenant: string, messageStore: MessageStore): Promise<void> {
    if (this.message.descriptor.protocol !== undefined) {
      await ProtocolAuthorization.authorize(tenant, this, this.author, messageStore);
    } else {
      await authorize(tenant, this);
    }
  }

  /**
   * Validates the integrity of the RecordsWrite message assuming the message passed basic schema validation.
   * There is opportunity to integrate better with `validateSchema(...)`
   */
  private async validateIntegrity(): Promise<void> {
    // make sure the same `recordId` in message is the same as the `recordId` in `authorization`
    if (this.message.recordId !== this.authorizationPayload.recordId) {
      throw new Error(
        `recordId in message ${this.message.recordId} does not match recordId in authorization: ${this.authorizationPayload.recordId}`
      );
    }

    // if the new message is the initial write
    const isInitialWrite = await this.isInitialWrite();
    if (isInitialWrite) {
      // `dateModified` and `dateCreated` equality check
      const dateCreated = this.message.descriptor.dateCreated;
      const dateModified = this.message.descriptor.dateModified;
      if (dateModified !== dateCreated) {
        throw new Error(`dateModified ${dateModified} must match dateCreated ${dateCreated} for the initial write`);
      }

      // if the message is also a protocol context root, the `contextId` must match the expected deterministic value
      if (this.message.descriptor.protocol !== undefined &&
        this.message.descriptor.parentId === undefined) {
        const expectedContextId = await this.getEntryId();

        if (this.message.contextId !== expectedContextId) {
          throw new Error(`contextId in message: ${this.message.contextId} does not match deterministic contextId: ${expectedContextId}`);
        }
      }
    }

    // if `contextId` is given in message, make sure the same `contextId` is in the `authorization`
    if (this.message.contextId !== this.authorizationPayload.contextId) {
      throw new Error(
        `contextId in message ${this.message.contextId} does not match contextId in authorization: ${this.authorizationPayload.contextId}`
      );
    }

    // if `attestation` is given in message, make sure the correct `attestationCid` is in the `authorization`
    if (this.message.attestation !== undefined) {
      const expectedAttestationCid = await computeCid(this.message.attestation);
      const actualAttestationCid = this.authorizationPayload.attestationCid;
      if (actualAttestationCid !== expectedAttestationCid) {
        throw new Error(
          `CID ${expectedAttestationCid} of attestation property in message does not match attestationCid in authorization: ${actualAttestationCid}`
        );
      }
    }
  }

  /**
   * Validates the structural integrity of the `attestation` property.
   * NOTE: signature is not verified.
   */
  private static async validateAttestationIntegrity(message: RecordsWriteMessage): Promise<void> {
    if (message.attestation === undefined) {
      return;
    }

    // TODO: multi-attesters to be unblocked by #205 - Revisit database interfaces (https://github.com/TBD54566975/dwn-sdk-js/issues/205)
    if (message.attestation.signatures.length !== 1) {
      throw new Error(`Currently implementation only supports 1 attester, but got ${message.attestation.signatures.length}`);
    }

    const payloadJson = Jws.decodePlainObjectPayload(message.attestation);
    const { descriptorCid } = payloadJson;

    // `descriptorCid` validation - ensure that the provided descriptorCid matches the CID of the actual message
    const expectedDescriptorCid = await computeCid(message.descriptor);
    if (descriptorCid !== expectedDescriptorCid) {
      throw new Error(`descriptorCid ${descriptorCid} does not match expected descriptorCid ${expectedDescriptorCid}`);
    }

    // check to ensure that no other unexpected properties exist in payload.
    const propertyCount = Object.keys(payloadJson).length;
    if (propertyCount > 1) {
      throw new Error(`Only 'descriptorCid' is allowed in attestation payload, but got ${propertyCount} properties.`);
    }
  };

  /**
   * Computes the deterministic Entry ID of this message.
   */
  public async getEntryId(): Promise<string> {
    const entryId = await RecordsWrite.getEntryId(this.author, this.message.descriptor);
    return entryId;
  };

  /**
   * Computes the deterministic Entry ID of this message.
   */
  public static async getEntryId(author: string, descriptor: RecordsWriteDescriptor): Promise<string> {
    const entryIdInput = { ...descriptor };
    (entryIdInput as any).author = author;

    const cid = await computeCid(entryIdInput);
    return cid;
  };

  /**
   * Checks if the given message is the initial entry of a record.
   */
  public async isInitialWrite(): Promise<boolean> {
    const entryId = await this.getEntryId();
    return (entryId === this.message.recordId);
  }

  /**
   * Checks if the given message is the initial entry of a record.
   */
  public static async isInitialWrite(message: BaseMessage): Promise<boolean> {
    // can't be the initial write if the message is not a Records Write
    if (message.descriptor.interface !== DwnInterfaceName.Records ||
        message.descriptor.method !== DwnMethodName.Write) {
      return false;
    }

    const recordsWriteMessage = message as RecordsWriteMessage;
    const author = Message.getAuthor(message);
    const entryId = await RecordsWrite.getEntryId(author, recordsWriteMessage.descriptor);
    return (entryId === recordsWriteMessage.recordId);
  }

  /**
   * Creates the `attestation` property of a RecordsWrite message if given signature inputs; returns `undefined` otherwise.
   */
  private static async createAttestation(descriptorCid: string, signatureInputs?: SignatureInput[]): Promise<GeneralJws | undefined> {
    if (signatureInputs === undefined || signatureInputs.length === 0) {
      return undefined;
    }

    const attestationPayload: RecordsWriteAttestationPayload = { descriptorCid };
    const attestationPayloadBytes = Encoder.objectToBytes(attestationPayload);

    const signer = await GeneralJwsSigner.create(attestationPayloadBytes, signatureInputs);
    return signer.getJws();
  }

  /**
   * Creates the `authorization` property of a RecordsWrite message.
   */
  private static async createAuthorization(
    recordId: string,
    contextId: string | undefined,
    descriptorCid: string,
    attestation: GeneralJws | undefined,
    signatureInput: SignatureInput
  ): Promise<GeneralJws> {
    const authorizationPayload: RecordsWriteAuthorizationPayload = {
      recordId,
      descriptorCid
    };

    const attestationCid = attestation ? await computeCid(attestation) : undefined;

    if (contextId !== undefined) { authorizationPayload.contextId = contextId; } // assign `contextId` only if it is defined
    if (attestationCid !== undefined) { authorizationPayload.attestationCid = attestationCid; } // assign `attestationCid` only if it is defined

    const authorizationPayloadBytes = Encoder.objectToBytes(authorizationPayload);

    const signer = await GeneralJwsSigner.create(authorizationPayloadBytes, [signatureInput]);
    return signer.getJws();
  }

  /**
   * Gets the initial write from the given list or record write.
   */
  public static async getInitialWrite(messages: BaseMessage[]): Promise<RecordsWriteMessage>{
    for (const message of messages) {
      if (await RecordsWrite.isInitialWrite(message)) {
        return message as RecordsWriteMessage;
      }
    }

    throw new Error(`initial write is not found`);
  }

  /**
   * Verifies that immutable properties of the two given messages are identical.
   * @throws {Error} if immutable properties between two RecordsWrite message
   */
  public static verifyEqualityOfImmutableProperties(existingWriteMessage: RecordsWriteMessage, newMessage: RecordsWriteMessage): boolean {
    const mutableDescriptorProperties = ['dataCid', 'dataSize', 'datePublished', 'published', 'dateModified'];

    // get distinct property names that exist in either the existing message given or new message
    let descriptorPropertyNames = [];
    descriptorPropertyNames.push(...Object.keys(existingWriteMessage.descriptor));
    descriptorPropertyNames.push(...Object.keys(newMessage.descriptor));
    descriptorPropertyNames = [...new Set(descriptorPropertyNames)]; // step to remove duplicates

    // ensure all immutable properties are not modified
    for (const descriptorPropertyName of descriptorPropertyNames) {
      // if property is supposed to be immutable
      if (mutableDescriptorProperties.indexOf(descriptorPropertyName) === -1) {
        const valueInExistingWrite = existingWriteMessage.descriptor[descriptorPropertyName];
        const valueInNewMessage = newMessage.descriptor[descriptorPropertyName];
        if (valueInNewMessage !== valueInExistingWrite) {
          throw new Error(`${descriptorPropertyName} is an immutable property: cannot change '${valueInExistingWrite}' to '${valueInNewMessage}'`);
        }
      }
    }

    return true;
  }

  /**
   * Gets the DID of the author of the given message.
   */
  public static getAttesters(message: RecordsWriteMessage): string[] {
    const attestationSignatures = message.attestation?.signatures ?? [];
    const attesters = attestationSignatures.map((signature) => Jws.getSignerDid(signature));
    return attesters;
  }
}
