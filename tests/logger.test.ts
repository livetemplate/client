import { createLogger, Logger, LogLevel } from "../utils/logger";

describe("Logger", () => {
  let mockConsole: {
    error: jest.Mock;
    warn: jest.Mock;
    info: jest.Mock;
    debug: jest.Mock;
    log: jest.Mock;
  };

  beforeEach(() => {
    mockConsole = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
    };
  });

  describe("createLogger", () => {
    it("creates logger with default options", () => {
      const logger = createLogger({ sink: mockConsole as unknown as Console });
      expect(logger.getLevel()).toBe("info");
    });

    it("respects custom log level", () => {
      const logger = createLogger({
        level: "debug",
        sink: mockConsole as unknown as Console,
      });
      expect(logger.getLevel()).toBe("debug");
    });

    it("accepts scope as string", () => {
      const logger = createLogger({
        scope: "TestScope",
        sink: mockConsole as unknown as Console,
      });
      logger.info("test message");
      expect(mockConsole.info).toHaveBeenCalledWith(
        "[LiveTemplate:TestScope]",
        "test message"
      );
    });

    it("accepts scope as array", () => {
      const logger = createLogger({
        scope: ["Parent", "Child"],
        sink: mockConsole as unknown as Console,
      });
      logger.info("test message");
      expect(mockConsole.info).toHaveBeenCalledWith(
        "[LiveTemplate:Parent:Child]",
        "test message"
      );
    });
  });

  describe("log level filtering", () => {
    it("silent level suppresses all logs", () => {
      const logger = createLogger({
        level: "silent",
        sink: mockConsole as unknown as Console,
      });
      logger.error("error");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(mockConsole.error).not.toHaveBeenCalled();
      expect(mockConsole.warn).not.toHaveBeenCalled();
      expect(mockConsole.info).not.toHaveBeenCalled();
      expect(mockConsole.debug).not.toHaveBeenCalled();
    });

    it("error level only shows errors", () => {
      const logger = createLogger({
        level: "error",
        sink: mockConsole as unknown as Console,
      });
      logger.error("error");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(mockConsole.error).toHaveBeenCalledTimes(1);
      expect(mockConsole.warn).not.toHaveBeenCalled();
      expect(mockConsole.info).not.toHaveBeenCalled();
      expect(mockConsole.debug).not.toHaveBeenCalled();
    });

    it("warn level shows errors and warnings", () => {
      const logger = createLogger({
        level: "warn",
        sink: mockConsole as unknown as Console,
      });
      logger.error("error");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(mockConsole.error).toHaveBeenCalledTimes(1);
      expect(mockConsole.warn).toHaveBeenCalledTimes(1);
      expect(mockConsole.info).not.toHaveBeenCalled();
      expect(mockConsole.debug).not.toHaveBeenCalled();
    });

    it("info level shows errors, warnings, and info", () => {
      const logger = createLogger({
        level: "info",
        sink: mockConsole as unknown as Console,
      });
      logger.error("error");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(mockConsole.error).toHaveBeenCalledTimes(1);
      expect(mockConsole.warn).toHaveBeenCalledTimes(1);
      expect(mockConsole.info).toHaveBeenCalledTimes(1);
      expect(mockConsole.debug).not.toHaveBeenCalled();
    });

    it("debug level shows all logs", () => {
      const logger = createLogger({
        level: "debug",
        sink: mockConsole as unknown as Console,
      });
      logger.error("error");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(mockConsole.error).toHaveBeenCalledTimes(1);
      expect(mockConsole.warn).toHaveBeenCalledTimes(1);
      expect(mockConsole.info).toHaveBeenCalledTimes(1);
      expect(mockConsole.debug).toHaveBeenCalledTimes(1);
    });
  });

  describe("setLevel", () => {
    it("changes log level dynamically", () => {
      const logger = createLogger({
        level: "silent",
        sink: mockConsole as unknown as Console,
      });

      logger.info("should not appear");
      expect(mockConsole.info).not.toHaveBeenCalled();

      logger.setLevel("info");
      logger.info("should appear");
      expect(mockConsole.info).toHaveBeenCalledTimes(1);
    });
  });

  describe("child", () => {
    it("creates scoped logger that shares state", () => {
      const parent = createLogger({
        level: "info",
        sink: mockConsole as unknown as Console,
      });
      const child = parent.child("ChildScope");

      child.info("child message");
      expect(mockConsole.info).toHaveBeenCalledWith(
        "[LiveTemplate:ChildScope]",
        "child message"
      );
    });

    it("child logger inherits level changes from parent", () => {
      const parent = createLogger({
        level: "silent",
        sink: mockConsole as unknown as Console,
      });
      const child = parent.child("Child");

      child.info("should not appear");
      expect(mockConsole.info).not.toHaveBeenCalled();

      parent.setLevel("info");
      child.info("should appear");
      expect(mockConsole.info).toHaveBeenCalledTimes(1);
    });

    it("supports multiple levels of nesting", () => {
      const root = createLogger({
        scope: "Root",
        sink: mockConsole as unknown as Console,
      });
      const level1 = root.child("Level1");
      const level2 = level1.child("Level2");

      level2.info("deep message");
      expect(mockConsole.info).toHaveBeenCalledWith(
        "[LiveTemplate:Root:Level1:Level2]",
        "deep message"
      );
    });
  });

  describe("isDebugEnabled", () => {
    it("returns true when level is debug", () => {
      const logger = createLogger({
        level: "debug",
        sink: mockConsole as unknown as Console,
      });
      expect(logger.isDebugEnabled()).toBe(true);
    });

    it("returns false when level is info or lower", () => {
      const logger = createLogger({
        level: "info",
        sink: mockConsole as unknown as Console,
      });
      expect(logger.isDebugEnabled()).toBe(false);
    });
  });

  describe("prefix formatting", () => {
    it("uses default prefix when no scope provided", () => {
      const logger = createLogger({ sink: mockConsole as unknown as Console });
      logger.info("test");
      expect(mockConsole.info).toHaveBeenCalledWith("[LiveTemplate]", "test");
    });

    it("includes scope in prefix", () => {
      const logger = createLogger({
        scope: "MyScope",
        sink: mockConsole as unknown as Console,
      });
      logger.info("test");
      expect(mockConsole.info).toHaveBeenCalledWith(
        "[LiveTemplate:MyScope]",
        "test"
      );
    });
  });

  describe("multiple arguments", () => {
    it("passes all arguments to console method", () => {
      const logger = createLogger({ sink: mockConsole as unknown as Console });
      logger.info("message", { data: 123 }, [1, 2, 3]);
      expect(mockConsole.info).toHaveBeenCalledWith(
        "[LiveTemplate]",
        "message",
        { data: 123 },
        [1, 2, 3]
      );
    });
  });
});
