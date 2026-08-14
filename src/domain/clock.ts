export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
