// Reach in Togle's window: this device among the person's devices, adding one by its code, and the tasks on the others.
// Reach is part of Togle Studio and stays out of every release until an outside review has tried to break it.
import type { Connection, DeviceKind } from './courier-protocol'
import type { TaskState } from './runner'

/** A device of the person's, as Togle's settings list it. */
export interface ReachDevice {
  device: string
  name: string
  role: DeviceKind
  /** This device. */
  me: boolean
  online: boolean
  /** A phone may type to agents and start tasks (set when it was added). */
  starts?: boolean
}

/** A request on another device's task, as that device shares it: the command always whole. */
export interface RemoteRequest {
  id: string
  kind: 'command' | 'edit' | 'question'
  command?: string
  files?: string[]
  /** A question's words, with text that looks like a key or a password hidden. */
  question?: string
  /** Why the command looks dangerous, in plain words. */
  danger?: string
}

/** A task on another device: the least this device needs to see it and answer it. */
export interface RemoteTask {
  key: string
  title: string
  agent: string
  /** The folder's own name ("infra"), not its whole path. */
  folder: string
  state: TaskState
  /** What it is doing or waiting for, in one line, with text that looks like a key or a password hidden. */
  line: string
  pending: RemoteRequest[]
  /** Togle runs it there, so it can be refused and stopped from here. */
  mine: boolean
  /** It runs in a terminal there: it is watched from here and answered only there. */
  terminal?: boolean
  /** A command may still run after Stop, so a second press is offered. */
  commandsRunning: boolean
  updatedAt: number
}

/** One device's tasks, as it last shared them. */
export interface DeviceTasks {
  device: string
  name: string
  role: DeviceKind
  online: boolean
  tasks: RemoteTask[]
  /** When they were shared. */
  at: number
}

/** What another device may ask a computer to do with one of its tasks without proof that the person is there. */
export interface RemoteAct {
  what: 'refuse' | 'stop' | 'end-commands'
  task: string
  request?: string
}

/** Something another device did on this computer, for the record this computer keeps. */
export interface ActedHere {
  at: number
  device: string
  name: string
  /** In words: "Stopped Fix the login redirect". */
  what: string
}

export interface ReachState {
  /** Reach is in this Togle: a development run with a courier set. */
  available: boolean
  /** Signed in to Togle Studio on this computer. */
  account?: { email: string }
  link: 'off' | 'connecting' | 'guest' | 'member' | 'refused'
  /** For a device of the group: whether the connection is on, waiting for Pro, or switched off in the account. */
  connection?: Connection
  /** Whether this device is one of the person's devices, or was removed from them. */
  standing: 'alone' | 'member' | 'removed'
  /** Signed in to an account that has devices already: this computer is added from one of them, or starts again. */
  addFromAnother?: boolean
  me?: { device: string; name: string; role: DeviceKind }
  devices: ReachDevice[]
  /** This device's code, while it shows one. */
  code?: { code: string; expiresAt: number; joined: boolean; problem?: string }
  /** A device being added here, by the code the person typed. */
  adding?: { stage: 'joining' | 'confirm' | 'adding' | 'added' | 'failed'; name?: string; role?: DeviceKind; message?: string }
  /** Other devices may act on this computer. */
  actOnThis: boolean
  /** What other devices did here lately, newest first. */
  acted: ActedHere[]
  /** Something went wrong that the person can do something about, in words. */
  problem?: string
}
