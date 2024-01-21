package org.opensearch.migrations.replay;

import lombok.NonNull;
import org.opensearch.migrations.coreutils.MetricsLogger;

import java.util.Optional;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

public class TupleParserChainConsumer implements Consumer<SourceTargetCaptureTuple> {
    private final BiConsumer<SourceTargetCaptureTuple, ParsedHttpMessagesAsDicts> innerConsumer;

    public TupleParserChainConsumer(@NonNull BiConsumer<SourceTargetCaptureTuple,
                                            ParsedHttpMessagesAsDicts> innerConsumer) {
        this.innerConsumer = innerConsumer;
    }

    @Override
    public void accept(SourceTargetCaptureTuple tuple) {
        var parsedMsgs = new ParsedHttpMessagesAsDicts(tuple);
        innerConsumer.accept(tuple, parsedMsgs);
    }
}
