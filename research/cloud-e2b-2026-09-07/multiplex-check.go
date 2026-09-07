package main

import (
	"fmt"
	"time"
)

func receive(ch <-chan int) int {
	select {
	case value := <-ch:
		return value
	case <-time.After(time.Second):
		panic("expected local channel delivery within one second")
	}
}

func main() {
	// A witness drains old output before the reconnecting subscriber exists.
	m := NewMultiplexedChannel[int](64)
	witness, cancelWitness := m.Fork()
	m.Source <- 1
	if receive(witness) != 1 {
		panic("wrong initial event")
	}
	reconnected, cancelReconnected := m.Fork()
	m.Source <- 2
	if receive(witness) != 2 || receive(reconnected) != 2 {
		panic("wrong live event")
	}
	cancelWitness()
	cancelReconnected()
	close(m.Source)
	fmt.Println("PASS: a new subscriber receives future output, without replay of the drained event")

	w := NewMultiplexedChannel[int](64)
	_, cancelGhost := w.Fork()
	live, cancelLive := w.Fork()
	w.Source <- 3
	select {
	case <-live:
		panic("expected an unread earlier subscriber to block fan-out")
	case <-time.After(100 * time.Millisecond):
	}
	cancelGhost()
	if receive(live) != 3 {
		panic("cancellation did not release fan-out")
	}
	cancelLive()
	close(w.Source)
	fmt.Println("PASS: an unread subscriber blocks the later subscriber until cancellation")
	fmt.Println("Evidence: actual upstream multiplex.go in a local standard-library-only process; no sandbox or network")
}
