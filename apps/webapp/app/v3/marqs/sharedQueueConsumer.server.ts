import { Context, ROOT_CONTEXT, Span, SpanKind, context, trace } from "@opentelemetry/api";
import {
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  TaskRunError,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  ZodMessageSender,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { BackgroundWorker, BackgroundWorkerTask } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { EnvironmentVariablesRepository } from "../environmentVariables/environmentVariablesRepository.server";
import { CancelAttemptService } from "../services/cancelAttempt.server";
import { socketIo } from "../handleSocketIo.server";
import { singleton } from "~/utils/singleton";
import { RestoreCheckpointService } from "../services/restoreCheckpoint.server";

const tracer = trace.getTracer("sharedQueueConsumer");

const MessageBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("EXECUTE"),
    taskIdentifier: z.string(),
  }),
  z.object({
    type: z.literal("RESUME"),
    completedAttemptIds: z.string().array(),
    resumableAttemptId: z.string(),
  }),
  z.object({
    type: z.literal("RESUME_AFTER_DURATION"),
    resumableAttemptId: z.string(),
  }),
]);

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type SharedQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
  nextTickInterval?: number;
  interval?: number;
};

export class SharedQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _deprecatedWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _options: Required<SharedQueueConsumerOptions>;
  private _perTraceCountdown: number | undefined;
  private _lastNewTrace: Date | undefined;
  private _currentSpanContext: Context | undefined;
  private _taskFailures: number = 0;
  private _taskSuccesses: number = 0;
  private _currentSpan: Span | undefined;
  private _endSpanInNextIteration = false;
  private _tasks = sharedQueueTasks;
  private _inProgressAttempts: Map<string, string> = new Map(); // Keys are task attempt friendly IDs, values are TaskRun ids/queue message ids

  constructor(
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>,
    options: SharedQueueConsumerOptions = {}
  ) {
    this._options = {
      maximumItemsPerTrace: options.maximumItemsPerTrace ?? 1_000, // 1k items per trace
      traceTimeoutSeconds: options.traceTimeoutSeconds ?? 60, // 60 seconds
      nextTickInterval: options.nextTickInterval ?? 1000, // 1 second
      interval: options.interval ?? 100, // 100ms
    };
  }

  // This method is called when a background worker is deprecated and will no longer be used unless a run is locked to it
  public async deprecateBackgroundWorker(id: string) {
    const backgroundWorker = this._backgroundWorkers.get(id);

    if (!backgroundWorker) {
      return;
    }

    this._deprecatedWorkers.set(id, backgroundWorker);
    this._backgroundWorkers.delete(id);
  }

  public async registerBackgroundWorker(id: string, envId?: string) {
    if (!envId) {
      logger.error("Environment ID is required for background worker registration", {
        backgroundWorkerId: id,
      });
      return;
    }

    const backgroundWorker = await prisma.backgroundWorker.findUnique({
      where: {
        friendlyId: id,
        runtimeEnvironmentId: envId,
      },
      include: {
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      return;
    }

    this._backgroundWorkers.set(backgroundWorker.id, backgroundWorker);

    logger.debug("Registered background worker", { backgroundWorker: backgroundWorker.id });

    // Start reading from the queue if we haven't already
    this.#enable();
  }

  public async start() {
    this.#enable();
  }

  public async stop(reason: string = "Provider disconnected") {
    if (!this._enabled) {
      return;
    }

    logger.debug("Stopping shared queue consumer");
    this._enabled = false;

    // TODO: think about automatic prod cancellation

    // We need to cancel all the in progress task run attempts and ack the messages so they will stop processing
    // await this.#cancelInProgressAttempts(reason);
  }

  async #cancelInProgressAttempts(reason: string) {
    const service = new CancelAttemptService();

    const cancelledAt = new Date();

    const inProgressAttempts = new Map(this._inProgressAttempts);

    this._inProgressAttempts.clear();

    for (const [attemptId, messageId] of inProgressAttempts) {
      await this.#cancelInProgressAttempt(attemptId, messageId, service, cancelledAt, reason);
    }
  }

  async #cancelInProgressAttempt(
    attemptId: string,
    messageId: string,
    cancelAttemptService: CancelAttemptService,
    cancelledAt: Date,
    reason: string
  ) {
    try {
      await cancelAttemptService.call(attemptId, messageId, cancelledAt, reason);
    } catch (e) {
      logger.error("Failed to cancel in progress attempt", {
        attemptId,
        messageId,
        error: e,
      });
    }
  }

  #enable() {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    this._perTraceCountdown = this._options.maximumItemsPerTrace;
    this._lastNewTrace = new Date();
    this._taskFailures = 0;
    this._taskSuccesses = 0;

    this.#doWork().finally(() => {});
  }

  async #doWork() {
    if (!this._enabled) {
      return;
    }

    // Check if the trace has expired
    if (
      this._perTraceCountdown === 0 ||
      Date.now() - this._lastNewTrace!.getTime() > this._options.traceTimeoutSeconds * 1000 ||
      this._currentSpanContext === undefined ||
      this._endSpanInNextIteration
    ) {
      if (this._currentSpan) {
        this._currentSpan.setAttribute("tasks.period.failures", this._taskFailures);
        this._currentSpan.setAttribute("tasks.period.successes", this._taskSuccesses);

        this._currentSpan.end();
      }

      // Create a new trace
      this._currentSpan = tracer.startSpan(
        "SharedQueueConsumer.doWork()",
        {
          kind: SpanKind.CONSUMER,
        },
        ROOT_CONTEXT
      );

      // Get the span trace context
      this._currentSpanContext = trace.setSpan(ROOT_CONTEXT, this._currentSpan);

      this._perTraceCountdown = this._options.maximumItemsPerTrace;
      this._lastNewTrace = new Date();
      this._taskFailures = 0;
      this._taskSuccesses = 0;
      this._endSpanInNextIteration = false;
    }

    return context.with(this._currentSpanContext ?? ROOT_CONTEXT, async () => {
      await this.#doWorkInternal();
      this._perTraceCountdown = this._perTraceCountdown! - 1;
    });
  }

  async #doWorkInternal() {
    // Attempt to dequeue a message from the shared queue
    // If no message is available, reschedule the worker to run again in 1 second
    // If a message is available, find the BackgroundWorkerTask that matches the message's taskIdentifier
    // If no matching task is found, nack the message and reschedule the worker to run again in 1 second
    // If the matching task is found, create the task attempt and lock the task run, then send the task run to the client
    // Store the message as a processing message
    // If the websocket connection disconnects before the task run is completed, nack the message
    // When the task run completes, ack the message
    // Using a heartbeat mechanism, if the client keeps responding with a heartbeat, we'll keep the message processing and increase the visibility timeout.

    const message = await marqs?.dequeueMessageInSharedQueue();

    if (!message) {
      setTimeout(() => this.#doWork(), this._options.nextTickInterval);
      return;
    }

    logger.log("dequeueMessageInSharedQueue()", { queueMessage: message });

    const envId = this.#envIdFromQueue(message.queue);

    const environment = await prisma.runtimeEnvironment.findUnique({
      include: {
        organization: true,
        project: true,
      },
      where: {
        id: envId,
      },
    });

    if (!environment) {
      logger.error("Environment not found", {
        queueMessage: message.data,
        envId,
      });
      await marqs?.acknowledgeMessage(message.messageId);
      setTimeout(() => this.#doWork(), this._options.interval);
      return;
    }

    const messageBody = MessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
        env: environment,
      });

      await marqs?.acknowledgeMessage(message.messageId);

      setTimeout(() => this.#doWork(), this._options.interval);
      return;
    }

    switch (messageBody.data.type) {
      case "EXECUTE": {
        const existingTaskRun = await prisma.taskRun.findUnique({
          where: {
            id: message.messageId,
          },
        });

        if (!existingTaskRun) {
          logger.error("No existing task run", {
            queueMessage: message.data,
            messageId: message.messageId,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        if (
          existingTaskRun.status !== "PENDING" &&
          existingTaskRun.status !== "RETRYING_AFTER_FAILURE"
        ) {
          logger.debug("Task run is not pending, aborting", {
            queueMessage: message.data,
            messageId: message.messageId,
            taskRun: existingTaskRun.id,
            status: existingTaskRun.status,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const deployment = await prisma.workerDeployment.findFirst({
          where: {
            environmentId: existingTaskRun.runtimeEnvironmentId,
            projectId: existingTaskRun.projectId,
            status: "DEPLOYED",
            imageReference: {
              not: null,
            },
          },
          orderBy: {
            updatedAt: "desc",
          },
          include: {
            worker: {
              include: {
                tasks: true,
              },
            },
          },
        });

        if (!deployment || !deployment.worker) {
          logger.error("No matching deployment found for task run", {
            queueMessage: message.data,
            messageId: message.messageId,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        if (!deployment.imageReference) {
          logger.error("Deployment is missing an image reference", {
            queueMessage: message.data,
            messageId: message.messageId,
            deployment: deployment.id,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const backgroundTask = deployment.worker.tasks.find(
          (task) => task.slug === existingTaskRun.taskIdentifier
        );

        if (!backgroundTask) {
          logger.warn("No matching background task found for task run", {
            taskRun: existingTaskRun.id,
            taskIdentifier: existingTaskRun.taskIdentifier,
            deployment: deployment.id,
            backgroundWorker: deployment.worker.id,
            taskSlugs: deployment.worker.tasks.map((task) => task.slug),
          });

          await marqs?.acknowledgeMessage(message.messageId);

          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const lockedTaskRun = await prisma.taskRun.update({
          where: {
            id: message.messageId,
          },
          data: {
            lockedAt: new Date(),
            lockedById: backgroundTask.id,
          },
          include: {
            attempts: {
              take: 1,
              orderBy: { number: "desc" },
            },
            tags: true,
            checkpoints: {
              take: 1,
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        });

        if (!lockedTaskRun) {
          logger.warn("Failed to lock task run", {
            taskRun: existingTaskRun.id,
            taskIdentifier: existingTaskRun.taskIdentifier,
            deployment: deployment.id,
            backgroundWorker: deployment.worker.id,
            messageId: message.messageId,
          });

          await marqs?.acknowledgeMessage(message.messageId);

          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: environment.id,
              name: lockedTaskRun.queue,
            },
          },
        });

        if (!queue) {
          await marqs?.nackMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.nextTickInterval);
          return;
        }

        if (!this._enabled) {
          await marqs?.nackMessage(message.messageId);
          return;
        }

        const taskRunAttempt = await prisma.taskRunAttempt.create({
          data: {
            number: lockedTaskRun.attempts[0] ? lockedTaskRun.attempts[0].number + 1 : 1,
            friendlyId: generateFriendlyId("attempt"),
            taskRunId: lockedTaskRun.id,
            startedAt: new Date(),
            backgroundWorkerId: backgroundTask.workerId,
            backgroundWorkerTaskId: backgroundTask.id,
            status: "PENDING" as const,
            queueId: queue.id,
            runtimeEnvironmentId: environment.id,
          },
        });

        try {
          const latestCheckpoint = lockedTaskRun.checkpoints[0];

          if (lockedTaskRun.status === "RETRYING_AFTER_FAILURE" && latestCheckpoint) {
            if (latestCheckpoint.reason !== "RETRYING_AFTER_FAILURE") {
              logger.error("Latest checkpoint is invalid", {
                queueMessage: message.data,
                messageId: message.messageId,
                resumableAttemptId: taskRunAttempt.id,
                latestCheckpointId: latestCheckpoint.id,
              });
              await marqs?.acknowledgeMessage(message.messageId);
              setTimeout(() => this.#doWork(), this._options.interval);
              return;
            }

            const restoreService = new RestoreCheckpointService();
            await restoreService.call({ checkpointId: latestCheckpoint.id });
          } else {
            await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
              backgroundWorkerId: deployment.worker.friendlyId,
              data: {
                type: "SCHEDULE_ATTEMPT",
                id: taskRunAttempt.id,
                image: deployment.imageReference,
                envId: environment.id,
                runId: taskRunAttempt.taskRunId,
              },
            });
          }

          this._inProgressAttempts.set(taskRunAttempt.friendlyId, message.messageId);
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          // We now need to unlock the task run and delete the task run attempt
          await prisma.$transaction([
            prisma.taskRun.update({
              where: {
                id: lockedTaskRun.id,
              },
              data: {
                lockedAt: null,
                lockedById: null,
              },
            }),
            prisma.taskRunAttempt.delete({
              where: {
                id: taskRunAttempt.id,
              },
            }),
          ]);

          // Finally we need to nack the message so it can be retried
          await marqs?.nackMessage(message.messageId);
        } finally {
          setTimeout(() => this.#doWork(), this._options.interval);
        }
        break;
      }
      // Resume after dependency completed with no remaining retries
      case "RESUME": {
        if (messageBody.data.completedAttemptIds.length < 1) {
          logger.error("No attempt IDs provided", {
            queueMessage: message.data,
            messageId: message.messageId,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const resumableRun = await prisma.taskRun.findUnique({
          where: {
            id: message.messageId,
          },
        });

        if (!resumableRun) {
          logger.error("Resumable run not found", {
            queueMessage: message.data,
            messageId: message.messageId,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const resumableAttempt = await prisma.taskRunAttempt.findUnique({
          where: {
            id: messageBody.data.resumableAttemptId,
          },
          include: {
            checkpoints: {
              take: 1,
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        });

        if (!resumableAttempt) {
          logger.error("Resumable attempt not found", {
            queueMessage: message.data,
            messageId: message.messageId,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: environment.id,
              name: resumableRun.queue,
            },
          },
        });

        if (!queue) {
          await marqs?.nackMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.nextTickInterval);
          return;
        }

        if (!this._enabled) {
          await marqs?.nackMessage(message.messageId);
          return;
        }

        if (resumableAttempt.status === "PAUSED") {
          // We need to restore the attempt from the latest checkpoint before we can resume
          const latestCheckpoint = resumableAttempt.checkpoints[0];

          if (!latestCheckpoint) {
            logger.error("No checkpoint found", {
              queueMessage: message.data,
              messageId: message.messageId,
              resumableAttemptId: resumableAttempt.id,
            });
            await marqs?.acknowledgeMessage(message.messageId);
            setTimeout(() => this.#doWork(), this._options.interval);
            return;
          }

          const restoreService = new RestoreCheckpointService();
          await restoreService.call({ checkpointId: latestCheckpoint.id });

          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        const completions: TaskRunExecutionResult[] = [];
        const executions: TaskRunExecution[] = [];

        for (const completedAttemptId of messageBody.data.completedAttemptIds) {
          const completedAttempt = await prisma.taskRunAttempt.findUnique({
            where: {
              id: completedAttemptId,
              taskRun: {
                lockedAt: {
                  not: null,
                },
                lockedById: {
                  not: null,
                },
              },
            },
          });

          if (!completedAttempt) {
            logger.error("Completed attempt not found", {
              queueMessage: message.data,
              messageId: message.messageId,
            });
            await marqs?.acknowledgeMessage(message.messageId);
            setTimeout(() => this.#doWork(), this._options.interval);
            return;
          }

          const completion = await this._tasks.getCompletionPayloadFromAttempt(completedAttempt.id);

          if (!completion) {
            await marqs?.acknowledgeMessage(message.messageId);
            setTimeout(() => this.#doWork(), this._options.interval);
            return;
          }

          completions.push(completion);

          const executionPayload = await this._tasks.getExecutionPayloadFromAttempt(
            completedAttempt.id
          );

          if (!executionPayload) {
            await marqs?.acknowledgeMessage(message.messageId);
            setTimeout(() => this.#doWork(), this._options.interval);
            return;
          }

          executions.push(executionPayload.execution);
        }

        try {
          // The attempt should still be running so we can broadcast to all coordinators to resume immediately
          socketIo.coordinatorNamespace.emit("RESUME", {
            version: "v1",
            attemptId: resumableAttempt.id,
            completions,
            executions,
          });
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          // Finally we need to nack the message so it can be retried
          await marqs?.nackMessage(message.messageId);
        } finally {
          setTimeout(() => this.#doWork(), this._options.interval);
        }
        break;
      }
      // Resume after duration-based wait
      case "RESUME_AFTER_DURATION": {
        const resumableAttempt = await prisma.taskRunAttempt.findUnique({
          where: {
            id: messageBody.data.resumableAttemptId,
          },
          include: {
            checkpoints: {
              take: 1,
              orderBy: {
                createdAt: "desc",
              },
            },
            taskRun: true,
          },
        });

        if (!resumableAttempt) {
          logger.error("Resumable attempt not found", {
            queueMessage: message.data,
            messageId: message.messageId,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        if (resumableAttempt.status !== "PAUSED") {
          logger.error("Attempt not paused", {
            queueMessage: message.data,
            messageId: message.messageId,
          });
          await marqs?.acknowledgeMessage(message.messageId);
          setTimeout(() => this.#doWork(), this._options.interval);
          return;
        }

        try {
          // We need to restore the attempt from the latest checkpoint before we can resume
          const latestCheckpoint = resumableAttempt.checkpoints[0];

          if (!latestCheckpoint) {
            logger.error("No checkpoint found", {
              queueMessage: message.data,
              messageId: message.messageId,
              resumableAttemptId: resumableAttempt.id,
            });
            await marqs?.acknowledgeMessage(message.messageId);
            setTimeout(() => this.#doWork(), this._options.interval);
            return;
          }

          // The attempt will resume automatically after restore
          const restoreService = new RestoreCheckpointService();
          await restoreService.call({ checkpointId: latestCheckpoint.id });
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          // Finally we need to nack the message so it can be retried
          await marqs?.nackMessage(message.messageId);
        } finally {
          setTimeout(() => this.#doWork(), this._options.interval);
        }
        break;
      }
    }
  }

  #envIdFromQueue(queueName: string) {
    return queueName.split(":")[1];
  }
}

class SharedQueueTasks {
  async getCompletionPayloadFromAttempt(id: string): Promise<TaskRunExecutionResult | undefined> {
    const attempt = await prisma.taskRunAttempt.findUnique({
      where: {
        id,
        status: {
          in: ["COMPLETED", "FAILED"],
        },
      },
      include: {
        backgroundWorker: true,
        backgroundWorkerTask: true,
        taskRun: {
          include: {
            runtimeEnvironment: {
              include: {
                organization: true,
                project: true,
              },
            },
            tags: true,
          },
        },
        queue: true,
      },
    });

    if (!attempt) {
      logger.error("No completed attempt found", { id });
      return;
    }

    const ok = attempt.status === "COMPLETED";

    if (ok) {
      const success: TaskRunSuccessfulExecutionResult = {
        ok,
        id: attempt.friendlyId,
        output: attempt.output ?? undefined,
        outputType: attempt.outputType,
      };
      return success;
    } else {
      const failure: TaskRunFailedExecutionResult = {
        ok,
        id: attempt.friendlyId,
        error: attempt.error as TaskRunError,
      };
      return failure;
    }
  }

  async getExecutionPayloadFromAttempt(
    id: string,
    setToExecuting?: boolean
  ): Promise<ProdTaskRunExecutionPayload | undefined> {
    const attempt = await prisma.taskRunAttempt.findUnique({
      where: {
        id,
      },
      include: {
        backgroundWorker: true,
        backgroundWorkerTask: true,
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
        taskRun: {
          include: {
            tags: true,
            batchItem: {
              include: {
                batchTaskRun: true,
              },
            },
          },
        },
        queue: true,
      },
    });

    if (!attempt) {
      logger.error("No attempt found", { id });
      return;
    }

    switch (attempt.status) {
      case "CANCELED":
      case "EXECUTING": {
        logger.error("Invalid attempt status for execution payload retrieval", {
          attemptId: id,
          status: attempt.status,
        });
        return;
      }
    }

    switch (attempt.taskRun.status) {
      case "CANCELED":
      case "EXECUTING":
      case "INTERRUPTED": {
        logger.error("Invalid run status for execution payload retrieval", {
          attemptId: id,
          runId: attempt.taskRunId,
          status: attempt.taskRun.status,
        });
        return;
      }
    }

    if (setToExecuting) {
      await prisma.taskRunAttempt.update({
        where: {
          id,
          taskRun: {
            status: {
              notIn: [
                "CANCELED",
                "COMPLETED_SUCCESSFULLY",
                "COMPLETED_WITH_ERRORS",
                "SYSTEM_FAILURE",
              ],
            },
          },
        },
        data: {
          status: "EXECUTING",
          taskRun: {
            update: {
              data: {
                status: "EXECUTING",
              },
            },
          },
        },
      });
    }

    const { backgroundWorkerTask, taskRun, queue } = attempt;

    const execution: ProdTaskRunExecution = {
      task: {
        id: backgroundWorkerTask.slug,
        filePath: backgroundWorkerTask.filePath,
        exportName: backgroundWorkerTask.exportName,
      },
      attempt: {
        id: attempt.friendlyId,
        number: attempt.number,
        startedAt: attempt.startedAt ?? attempt.createdAt,
        backgroundWorkerId: attempt.backgroundWorkerId,
        backgroundWorkerTaskId: attempt.backgroundWorkerTaskId,
        status: "EXECUTING" as const,
      },
      run: {
        id: taskRun.friendlyId,
        payload: taskRun.payload,
        payloadType: taskRun.payloadType,
        context: taskRun.context,
        createdAt: taskRun.createdAt,
        tags: taskRun.tags.map((tag) => tag.name),
        isTest: taskRun.isTest,
      },
      queue: {
        id: queue.friendlyId,
        name: queue.name,
      },
      environment: {
        id: attempt.runtimeEnvironment.id,
        slug: attempt.runtimeEnvironment.slug,
        type: attempt.runtimeEnvironment.type,
      },
      organization: {
        id: attempt.runtimeEnvironment.organization.id,
        slug: attempt.runtimeEnvironment.organization.slug,
        name: attempt.runtimeEnvironment.organization.title,
      },
      project: {
        id: attempt.runtimeEnvironment.project.id,
        ref: attempt.runtimeEnvironment.project.externalRef,
        slug: attempt.runtimeEnvironment.project.slug,
        name: attempt.runtimeEnvironment.project.name,
      },
      batch: taskRun.batchItem?.batchTaskRun
        ? { id: taskRun.batchItem.batchTaskRun.friendlyId }
        : undefined,
      worker: {
        id: attempt.backgroundWorkerId,
        contentHash: attempt.backgroundWorker.contentHash,
        version: attempt.backgroundWorker.version,
      },
    };

    const environmentRepository = new EnvironmentVariablesRepository();
    const variables = await environmentRepository.getEnvironmentVariables(
      attempt.runtimeEnvironment.projectId,
      attempt.runtimeEnvironmentId
    );

    const payload: ProdTaskRunExecutionPayload = {
      execution,
      traceContext: taskRun.traceContext as Record<string, unknown>,
      environment: variables.reduce((acc: Record<string, string>, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {}),
    };

    return payload;
  }

  async getLatestExecutionPayloadFromRun(
    id: string,
    setToExecuting?: boolean
  ): Promise<ProdTaskRunExecutionPayload | undefined> {
    const run = await prisma.taskRun.findUnique({
      where: {
        id,
      },
      include: {
        attempts: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    const latestAttempt = run?.attempts[0];

    if (!latestAttempt) {
      logger.error("No attempts for run", { id });
      return;
    }

    return this.getExecutionPayloadFromAttempt(latestAttempt.id, setToExecuting);
  }

  async taskHeartbeat(attemptFriendlyId: string, seconds: number = 60) {
    const taskRunAttempt = await prisma.taskRunAttempt.findUnique({
      where: { friendlyId: attemptFriendlyId },
    });

    if (!taskRunAttempt) {
      return;
    }

    await marqs?.heartbeatMessage(taskRunAttempt.taskRunId, seconds);
  }
}

export const sharedQueueTasks = singleton("sharedQueueTasks", () => new SharedQueueTasks());
