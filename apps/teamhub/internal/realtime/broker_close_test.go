package realtime

import (
	"testing"
	"time"
)

func TestSubscriptionCloseConcurrentWithSlowSubscriberDisconnect(t *testing.T) {
	for name, publish := range map[string]func(*Broker){
		"publish": func(broker *Broker) {
			broker.Publish(Event{Topic: "room:slow", Kind: "room.event", Sequence: 2})
		},
		"reconcile": func(broker *Broker) {
			broker.PublishAll()
		},
	} {
		t.Run(name, func(t *testing.T) {
			deadline := time.NewTimer(30 * time.Second)
			defer deadline.Stop()
			for range 1000 {
				broker := NewBroker(1)
				subscription := broker.Subscribe("room:slow")
				broker.Publish(Event{Topic: "room:slow", Kind: "room.event", Sequence: 1})
				start := make(chan struct{})
				finished := make(chan struct{}, 2)
				go func() {
					<-start
					subscription.Close()
					finished <- struct{}{}
				}()
				go func() {
					<-start
					publish(broker)
					finished <- struct{}{}
				}()
				close(start)
				for range 2 {
					select {
					case <-finished:
					case <-deadline.C:
						t.Fatal("subscription close and queue overflow blocked each other")
					}
				}
				subscription.Close()
				select {
				case <-subscription.Done():
				default:
					t.Fatal("closed subscription has no lifecycle signal")
				}
				if len(broker.topics) != 0 {
					t.Fatalf("closed subscription retained topics: %v", broker.topics)
				}
			}
		})
	}
}
