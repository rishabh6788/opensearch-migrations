package org.opensearch.migrations.trafficcapture.proxyserver.testcontainers;

import com.github.dockerjava.api.command.InspectContainerResponse;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.opensearch.migrations.testutils.PortFinder;
import org.opensearch.migrations.trafficcapture.proxyserver.CaptureProxy;
import org.testcontainers.containers.Container;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.KafkaContainer;
import org.testcontainers.containers.wait.strategy.HttpWaitStrategy;
import org.testcontainers.containers.wait.strategy.WaitStrategyTarget;
import org.testcontainers.lifecycle.Startable;

@Slf4j
public class CaptureProxyContainer
    extends GenericContainer implements AutoCloseable, WaitStrategyTarget, Startable {

  private static final Duration TIMEOUT_DURATION = Duration.ofSeconds(30);
  private final Supplier<String> destinationUriSupplier;
  private final Supplier<String> kafkaUriSupplier;
  private Integer listeningPort;
  private Thread serverThread;

  public CaptureProxyContainer(final Supplier<String> destinationUriSupplier,
      final Supplier<String> kafkaUriSupplier) {
    this.destinationUriSupplier = destinationUriSupplier;
    this.kafkaUriSupplier = kafkaUriSupplier;
  }

  public CaptureProxyContainer(final String destinationUri, final String kafkaUri) {
    this.destinationUriSupplier = () -> destinationUri;
    this.kafkaUriSupplier = () -> kafkaUri;
  }

  public CaptureProxyContainer(final Container<?> destination, final KafkaContainer kafka) {
    this(() -> getUriFromContainer(destination), () -> getUriFromContainer(kafka));
  }

  public static String getUriFromContainer(final Container<?> container) {
    return "http://" + container.getHost() + ":" + container.getFirstMappedPort();
  }

  @Override
  public void start() {
    this.listeningPort = PortFinder.findOpenPort();
    serverThread = new Thread(() -> {
      try {
        String[] args = {
            "--kafkaConnection", kafkaUriSupplier.get(),
            "--destinationUri", destinationUriSupplier.get(),
            "--listenPort", String.valueOf(listeningPort),
            "--insecureDestination"
        };

        CaptureProxy.main(args);
      } catch (Exception e) {
        throw new AssertionError("Should not have exception", e);
      }
    });

    serverThread.start();
    new HttpWaitStrategy().forPort(listeningPort)
        .withStartupTimeout(TIMEOUT_DURATION)
        .waitUntilReady(this);
  }

  @Override
  public boolean isRunning() {
    return serverThread != null;
  }

  @Override
  public void stop() {
    if (serverThread != null) {
      serverThread.interrupt();
      this.serverThread = null;
    }
    this.listeningPort = null;
    close();
  }

  @Override
  public void close() {
  }

  @Override
  public Set<Integer> getLivenessCheckPortNumbers() {
    return getExposedPorts()
        .stream()
        .map(this::getMappedPort)
        .collect(Collectors.toSet());
  }

  @Override
  public String getHost() {
    return "localhost";
  }

  @Override
  public Integer getMappedPort(int originalPort) {
    if (getExposedPorts().contains(originalPort)) {
      return listeningPort;
    }
    return null;
  }

  @Override
  public List<Integer> getExposedPorts() {
    // Internal and External ports are the same
    return List.of(listeningPort);
  }

  @Override
  public InspectContainerResponse getContainerInfo() {
    return new InspectNonContainerResponse("captureProxy");
  }

  @AllArgsConstructor
  static class InspectNonContainerResponse extends InspectContainerResponse {

    private String name;

    @Override
    public String getName() {
      return name;
    }
  }
}